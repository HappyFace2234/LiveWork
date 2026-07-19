package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/liveagent/agent-gateway/internal/auth"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/observability"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
)

// websocketRequest is the inbound envelope of the v1 JSON protocol.
//
// Deprecated: v1 JSON 协议信封，请改用 v2（WebSocket+Protobuf，internal/protocol/pbws）；v1 仅为旧客户端保留，流量归零后整体删除。
type websocketRequest struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// websocketEnvelope is the outbound envelope of the v1 JSON protocol.
//
// Deprecated: v1 JSON 协议信封，随 v1 一并移除（见 websocketRequest）。
type websocketEnvelope struct {
	ID      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Payload any    `json:"payload,omitempty"`
	Error   string `json:"error,omitempty"`

	// priority is transport-local metadata and is never serialized. It lets
	// latency-sensitive acknowledgements bypass a congested data queue without
	// promoting every potentially large response.
	priority bool
}

type websocketAuthPayload struct {
	Token string `json:"token"`
}

type websocketTerminalRequestPayload struct {
	SessionID      string `json:"session_id"`
	ProjectPathKey string `json:"project_path_key"`
	Cwd            string `json:"cwd"`
	Shell          string `json:"shell"`
	Title          string `json:"title"`
	Data           string `json:"data"`
	Cols           *int   `json:"cols"`
	Rows           *int   `json:"rows"`
	MaxBytes       *int   `json:"max_bytes"`
	SshHostID      string `json:"ssh_host_id"`
	PromptID       string `json:"prompt_id"`
	PromptAnswer   string `json:"prompt_answer"`
	TrustHostKey   bool   `json:"trust_host_key"`
	SftpEnabled    bool   `json:"sftp_enabled"`
	TabID          string `json:"tab_id"`
	TabKind        string `json:"tab_kind"`
}

type websocketSshKnownHostResetPayload struct {
	Host string `json:"host"`
	Port *int   `json:"port"`
}

type websocketSftpRequestPayload struct {
	SessionID           string `json:"session_id"`
	SessionIDCamel      string `json:"sessionId"`
	ProjectPathKey      string `json:"project_path_key"`
	ProjectPathKeyCamel string `json:"projectPathKey"`
	Workdir             string `json:"workdir"`
	Side                string `json:"side"`
	LocalPath           string `json:"local_path"`
	LocalPathCamel      string `json:"localPath"`
	RemotePath          string `json:"remote_path"`
	RemotePathCamel     string `json:"remotePath"`
	FromPath            string `json:"from_path"`
	FromPathCamel       string `json:"fromPath"`
	SourcePathCamel     string `json:"sourcePath"`
	ToPath              string `json:"to_path"`
	ToPathCamel         string `json:"toPath"`
	Direction           string `json:"direction"`
	TargetPath          string `json:"target_path"`
	TargetPathCamel     string `json:"targetPath"`
	TransferID          string `json:"transfer_id"`
	TransferIDCamel     string `json:"transferId"`
	Recursive           bool   `json:"recursive"`
	Overwrite           bool   `json:"overwrite"`
}

type websocketGitRequestPayload struct {
	Workdir string          `json:"workdir"`
	Args    json.RawMessage `json:"args,omitempty"`
}

const (
	websocketControlQueueSize = wscore.DefaultCtrlQueueSize
)

// websocketConnection is one browser connection speaking the v1 JSON
// protocol.
//
// Deprecated: v1 JSON 协议实现，v2 对应实现为 internal/protocol/pbws.browserConn；v1 流量归零后整体删除。
type websocketConnection struct {
	cfg *config.Config
	sm  *session.Manager

	conn *websocket.Conn
	req  *http.Request

	// core 承载传输运行时（写泵/双队列/掉帧/心跳/空闲驱逐），v1 层只做 JSON 信封编解码与分发；done 是 core.Done() 的只读别名，供各转发器 select。
	core *wscore.Conn
	done <-chan struct{}

	authorized bool

	historyEvents             <-chan *gatewayv1.HistorySyncEvent
	historyEventsCleanup      func()
	settingsEvents            <-chan *gatewayv1.SettingsSyncEvent
	settingsEventsCleanup     func()
	terminalEvents            <-chan *gatewayv1.TerminalEvent
	terminalEventsCleanup     func()
	sftpEvents                <-chan *gatewayv1.SftpEvent
	sftpEventsCleanup         func()
	chatQueueEvents           <-chan *gatewayv1.ChatQueueEvent
	chatQueueEventsCleanup    func()
	chatActivityEvents        <-chan session.ConversationActivityEvent
	chatActivityEventsCleanup func()
	tunnelStateEvents         <-chan *gatewayv1.TunnelStateSnapshot
	tunnelStateEventsCleanup  func()
	statusEvents              <-chan session.Status
	statusEventsCleanup       func()

	managedProcessEvents        <-chan *gatewayv1.ManagedProcessSnapshot
	managedProcessEventsCleanup func()

	terminalInterest *shared.TerminalInterestTracker

	chatStreamsMu sync.Mutex
	chatStreams   map[string]*chatStreamSubscription

	workspaceSubsMu sync.Mutex
	workspaceSubs   map[string]*workspaceActivitySubscription
}

const maxHistoryListLimit = 200
const defaultHistoryListPage = 1
const defaultHistoryListPageSize = 80

// NewWebSocketServer serves the v1 JSON protocol on /ws.
//
// Deprecated: v1 JSON 协议入口，仅服务未升级的旧客户端（如未刷新的浏览器标签页）；新客户端一律走 /ws/v2（internal/protocol/pbws.Server）。
func NewWebSocketServer(cfg *config.Config, sm *session.Manager) http.Handler {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return originAllowed(r)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn.SetReadLimit(webSocketReadLimit(cfg))

		state := &websocketConnection{
			cfg:              cfg,
			sm:               sm,
			conn:             conn,
			req:              r,
			terminalInterest: shared.NewTerminalInterestTracker(),
		}
		state.core = wscore.NewConn(conn, wscore.Config{
			WriteTimeout:    cfg.WebSocketWriteTimeout,
			QueueSize:       cfg.WebSocketWriteQueueSize,
			CtrlQueueSize:   websocketControlQueueSize,
			HeartbeatPeriod: cfg.WebSocketHeartbeatPeriod,
			HeartbeatGrace:  cfg.WebSocketHeartbeatGrace,
			Remote:          r.RemoteAddr,
			OnClose:         state.releaseSubscriptions,
		})
		state.done = state.core.Done()
		// Protocol-level pongs are produced by the browser's network stack
		// even while the page's JS is throttled or frozen in a hidden tab, so
		// they are the liveness signal that must count as inbound activity.
		conn.SetPongHandler(func(string) error {
			state.core.TouchInboundActivity()
			return nil
		})
		_ = conn.SetReadDeadline(time.Now().Add(state.core.IdleTimeout()))
		defer state.close()
		state.serve()
		// authorized 只在读循环内写、serve 返回后同 goroutine 读，无竞争；计数与 handleAuth 的 Active+1 配对。
		if state.authorized {
			observability.Usage.V1WSConnectionsActive.Add(-1)
		}
	})
}

func webSocketReadLimit(cfg *config.Config) int64 {
	if cfg != nil && cfg.GRPCMaxMessageBytes > 0 {
		return int64(cfg.GRPCMaxMessageBytes)
	}
	return int64(config.DefaultGRPCMaxMessageBytes)
}

func (c *websocketConnection) serve() {
	for {
		var req websocketRequest
		if err := c.conn.ReadJSON(&req); err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			return
		}

		// Any inbound frame proves the client is alive — heartbeat pongs are
		// not the only liveness evidence.
		c.core.TouchInboundActivity()

		req.ID = strings.TrimSpace(req.ID)
		req.Type = strings.TrimSpace(req.Type)
		if req.Type == "pong" {
			continue
		}
		// Pre-auth, nothing drains the write queues (writeLoop starts in
		// handleAuth), so error envelopes would only pile up while the
		// malformed frames keep refreshing the read deadline. The only valid
		// first request is auth; anything else ends the connection.
		if req.ID == "" {
			_ = c.writeError("", "request id is required")
			if !c.authorized {
				return
			}
			continue
		}
		if req.Type == "" {
			_ = c.writeError(req.ID, "request type is required")
			if !c.authorized {
				return
			}
			continue
		}

		if req.Type == "auth" {
			c.handleAuth(req)
			continue
		}

		if !c.authorized {
			_ = c.writeError(req.ID, "unauthorized")
			return
		}

		// Subscription lifecycle must keep the client's frame order: a
		// re-subscribe emits [unsubscribe, subscribe] back to back, and
		// concurrent dispatch could let the stale unsubscribe cancel the fresh
		// subscription. These handlers are lock-only and non-blocking, so they
		// run inline on the read loop.
		if req.Type == "chat.subscribe" || req.Type == "chat.unsubscribe" ||
			req.Type == "workspace.subscribe" || req.Type == "workspace.unsubscribe" {
			c.dispatch(req)
			continue
		}

		go c.dispatch(req)
	}
}

func (c *websocketConnection) close() {
	c.core.Close()
}

// releaseSubscriptions 由 core 关闭时回调（恰好一次），释放本连接持有的全部 session 层订阅与 chat/workspace 流。
func (c *websocketConnection) releaseSubscriptions() {
	if c.historyEventsCleanup != nil {
		c.historyEventsCleanup()
		c.historyEventsCleanup = nil
	}
	if c.settingsEventsCleanup != nil {
		c.settingsEventsCleanup()
		c.settingsEventsCleanup = nil
	}
	if c.terminalEventsCleanup != nil {
		c.terminalEventsCleanup()
		c.terminalEventsCleanup = nil
	}
	if c.sftpEventsCleanup != nil {
		c.sftpEventsCleanup()
		c.sftpEventsCleanup = nil
	}
	if c.chatQueueEventsCleanup != nil {
		c.chatQueueEventsCleanup()
		c.chatQueueEventsCleanup = nil
	}
	if c.chatActivityEventsCleanup != nil {
		c.chatActivityEventsCleanup()
		c.chatActivityEventsCleanup = nil
	}
	if c.tunnelStateEventsCleanup != nil {
		c.tunnelStateEventsCleanup()
		c.tunnelStateEventsCleanup = nil
	}
	if c.statusEventsCleanup != nil {
		c.statusEventsCleanup()
		c.statusEventsCleanup = nil
	}
	if c.managedProcessEventsCleanup != nil {
		c.managedProcessEventsCleanup()
		c.managedProcessEventsCleanup = nil
	}
	c.cleanupChatStreamSubscriptions()
	c.cleanupWorkspaceSubscriptions()
}

func (c *websocketConnection) handleAuth(req websocketRequest) {
	var payload websocketAuthPayload
	if err := decodeWebSocketPayload(req.Payload, &payload); err != nil {
		_ = c.writeError(req.ID, "invalid auth payload")
		c.close()
		return
	}

	if !auth.ValidateToken(payload.Token, c.cfg.Token) {
		_ = c.writeError(req.ID, "unauthorized")
		c.close()
		return
	}

	c.authorized = true
	// v1 使用打点：观察弃用链路流量归零后即可在后续版本删除 v1。
	observability.Usage.V1WSConnectionsTotal.Add(1)
	observability.Usage.V1WSConnectionsActive.Add(1)
	slog.Warn("deprecated v1 websocket connection established",
		"remote", c.req.RemoteAddr,
	)
	c.core.SetAuthorized()
	// The pre-auth deadline was deliberately left un-refreshed; re-arm it now
	// so a slow-to-auth client does not die moments after succeeding.
	c.core.TouchInboundActivity()
	c.core.StartWriteLoop()
	c.startHistorySyncForwarder()
	c.startSettingsSyncForwarder()
	c.startTerminalEventForwarder()
	c.startSftpEventForwarder()
	c.startChatQueueEventForwarder()
	c.startChatActivityForwarder()
	c.startTunnelStateForwarder()
	c.startManagedProcessStateForwarder()
	c.startStatusEventForwarder()
	c.core.StartHeartbeat(c.buildHeartbeatPing)
	if err := c.writeResponse(req.ID, map[string]any{"ok": true}); err != nil {
		c.close()
		return
	}
	c.replayTerminalSessionSnapshot()
	c.replayTunnelStateSnapshot()
	c.replayManagedProcessSnapshot()
	c.replayStatusSnapshot()
}

func (c *websocketConnection) startHistorySyncForwarder() {
	if c.historyEvents != nil || c.historyEventsCleanup != nil {
		return
	}

	historyEvents, cleanup := c.sm.SubscribeHistorySync()
	c.historyEvents = historyEvents
	c.historyEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-historyEvents:
				if !ok {
					return
				}
				if err := c.writeEvent("history.event", websocketHistorySyncPayload(event)); err != nil {
					if errors.Is(err, errWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startChatActivityForwarder() {
	if c.chatActivityEvents != nil || c.chatActivityEventsCleanup != nil {
		return
	}

	activityEvents, cleanup := c.sm.SubscribeChatActivity()
	c.chatActivityEvents = activityEvents
	c.chatActivityEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-activityEvents:
				if !ok {
					return
				}
				if err := c.writeEvent("chat.activity", websocketChatActivityPayload(event)); err != nil {
					if errors.Is(err, errWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

// startStatusEventForwarder pushes agent online/offline transitions so the
// client does not depend on a (background-throttled) status poll to notice
// them. Frames are sheddable: the fallback poll reconciles missed ones.
func (c *websocketConnection) startStatusEventForwarder() {
	if c.statusEvents != nil || c.statusEventsCleanup != nil {
		return
	}

	statusEvents, cleanup := c.sm.SubscribeStatus()
	c.statusEvents = statusEvents
	c.statusEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case status, ok := <-statusEvents:
				if !ok {
					return
				}
				if err := c.writeEvent("status.event", status); err != nil {
					if errors.Is(err, errWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

// replayStatusSnapshot paints the freshly authenticated socket with the
// current agent status so no poll round-trip is needed after (re)connect.
func (c *websocketConnection) replayStatusSnapshot() {
	_ = c.writeEvent("status.event", c.sm.Status())
}

func (c *websocketConnection) startSettingsSyncForwarder() {
	if c.settingsEvents != nil || c.settingsEventsCleanup != nil {
		return
	}

	settingsEvents, cleanup := c.sm.SubscribeSettingsSync()
	c.settingsEvents = settingsEvents
	c.settingsEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-settingsEvents:
				if !ok {
					return
				}
				payload, err := websocketSettingsJSONPayload(event.GetSettingsJson())
				if err != nil {
					return
				}
				if err := c.writeEvent("settings.event", payload); err != nil {
					if errors.Is(err, errWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startTerminalEventForwarder() {
	if c.terminalEvents != nil || c.terminalEventsCleanup != nil {
		return
	}

	terminalEvents, cleanup := c.sm.SubscribeTerminalEvents()
	c.terminalEvents = terminalEvents
	c.terminalEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-terminalEvents:
				if !ok {
					return
				}
				if !c.shouldForwardTerminalEvent(event) {
					continue
				}
				if err := c.writeEvent("terminal.event", websocketTerminalEventPayload(event)); err != nil {
					if errors.Is(err, errWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startSftpEventForwarder() {
	if c.sftpEvents != nil || c.sftpEventsCleanup != nil {
		return
	}

	sftpEvents, cleanup := c.sm.SubscribeSftpEvents()
	c.sftpEvents = sftpEvents
	c.sftpEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-sftpEvents:
				if !ok {
					return
				}
				if !c.sm.WebSshTerminalEnabled() {
					continue
				}
				if err := c.writeEvent("sftp.event", websocketSftpEventPayload(event)); err != nil {
					if errors.Is(err, errWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startChatQueueEventForwarder() {
	if c.chatQueueEvents != nil || c.chatQueueEventsCleanup != nil {
		return
	}

	chatQueueEvents, cleanup := c.sm.SubscribeChatQueueEvents()
	c.chatQueueEvents = chatQueueEvents
	c.chatQueueEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-chatQueueEvents:
				if !ok {
					return
				}
				if err := c.writeEvent("chat_queue.event", websocketChatQueueEventPayload(event)); err != nil {
					if errors.Is(err, errWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) replayTerminalSessionSnapshot() {
	if !c.terminalFeaturesEnabled() {
		return
	}
	for _, terminalSession := range c.sm.TerminalSessionSnapshot("") {
		if !c.terminalSessionAllowed(terminalSession) {
			continue
		}
		if err := c.writeEvent("terminal.event", websocketTerminalEventPayload(&gatewayv1.TerminalEvent{
			Kind:           "created",
			SessionId:      terminalSession.GetId(),
			ProjectPathKey: terminalSession.GetProjectPathKey(),
			Session:        terminalSession,
		})); err != nil {
			return
		}
	}
}

func (c *websocketConnection) shouldForwardTerminalEvent(event *gatewayv1.TerminalEvent) bool {
	return c.terminalEventAllowed(event) && c.terminalInterest.ShouldForward(event)
}

// buildHeartbeatPing 为 wscore 心跳循环构造 v1 JSON ping 信封帧。
func (c *websocketConnection) buildHeartbeatPing() (wscore.Frame, bool) {
	data, err := json.Marshal(websocketEnvelope{
		Type: "ping",
		Payload: map[string]any{
			"timestamp": time.Now().Unix(),
		},
	})
	if err != nil {
		return wscore.Frame{}, false
	}
	return wscore.Frame{
		Class:       wscore.FramePing,
		Kind:        "ping",
		MessageType: websocket.TextMessage,
		Data:        data,
	}, true
}

func (c *websocketConnection) dispatch(req websocketRequest) {
	observability.Usage.V1WSRequestsTotal.Add(1)
	handler := websocketRequestHandlers[req.Type]
	if handler == nil {
		_ = c.writeError(req.ID, "unsupported request type")
		return
	}
	handler(c, req)
}

func (c *websocketConnection) awaitAgentResponse(
	requestID string,
	envelope *gatewayv1.GatewayEnvelope,
) (*gatewayv1.AgentEnvelope, error) {
	ctx, cancel := context.WithTimeout(context.Background(), c.cfg.RequestTimeout)
	defer cancel()

	go func() {
		select {
		case <-c.done:
			cancel()
		case <-ctx.Done():
		}
	}()

	return awaitAgentUnaryResponse(ctx, c.sm, requestID, envelope)
}

func (c *websocketConnection) writeResponse(requestID string, payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:      requestID,
		Type:    "response",
		Payload: payload,
	})
}

func (c *websocketConnection) writePriorityResponse(requestID string, payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:       requestID,
		Type:     "response",
		Payload:  payload,
		priority: true,
	})
}

func (c *websocketConnection) writeError(requestID string, message string) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:    requestID,
		Type:  "error",
		Error: message,
	})
}

func (c *websocketConnection) writeEvent(eventType string, payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		Type:    eventType,
		Payload: payload,
	})
}

// errWriteQueueFull 是 wscore 掉帧错误的包内别名，保持既有 errors.Is 判定。
var errWriteQueueFull = wscore.ErrWriteQueueFull

// isControlEnvelopeType reports envelopes that must reach the client even
// when the data queue is congested: keep-alive pings and the signals a client
// needs to recover a shed stream.
func isControlEnvelopeType(envelopeType string) bool {
	switch envelopeType {
	case "ping", "error", "chat.subscription_reset", "chat.command_update":
		return true
	default:
		return false
	}
}

// classifyEnvelope 将 v1 信封映射为 wscore 帧类别（拥塞策略），逐字保持原 writeEnvelope 的路由语义。
func classifyEnvelope(envelope websocketEnvelope) wscore.FrameClass {
	switch {
	case envelope.Type == "ping":
		return wscore.FramePing
	case envelope.priority || isControlEnvelopeType(envelope.Type):
		return wscore.FrameControl
	case envelope.Type == "response" && envelope.ID != "":
		return wscore.FrameResponse
	default:
		return wscore.FrameData
	}
}

// writeEnvelope 编码 v1 JSON 信封并交给共享写泵；拥塞策略（控制帧优先、数据掉帧、关联响应关连接）由帧类别声明、wscore 统一执行。
func (c *websocketConnection) writeEnvelope(envelope websocketEnvelope) error {
	data, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	return c.core.Enqueue(wscore.Frame{
		Class:       classifyEnvelope(envelope),
		RequestID:   envelope.ID,
		Kind:        envelope.Type,
		MessageType: websocket.TextMessage,
		Data:        data,
	})
}
