package websocket_test

// v2（WebSocket+Protobuf）二进制帧测试 harness，与 v1 JSON harness 并列：起真实 httptest
// 服务器、以子协议拨号、按 proto 帧收发。v1 harness 在 v1 删除前保持不动。

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

func newV2TestConfig() *config.Config {
	return &config.Config{
		Token:          "ws-token",
		RequestTimeout: time.Second,
	}
}

// dialV2 起服务并以 v2 子协议拨号。
func dialV2(t *testing.T, handler http.Handler) (*websocket.Conn, func()) {
	t.Helper()
	ts := httptest.NewServer(handler)
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http")
	dialer := websocket.Dialer{Subprotocols: []string{pbws.Subprotocol}}
	conn, resp, err := dialer.Dial(wsURL, http.Header{
		"Origin": []string{ts.URL},
	})
	if err != nil {
		ts.Close()
		t.Fatalf("dial v2 websocket: %v", err)
	}
	if got := resp.Header.Get("Sec-Websocket-Protocol"); got != pbws.Subprotocol {
		_ = conn.Close()
		ts.Close()
		t.Fatalf("subprotocol = %q, want %q", got, pbws.Subprotocol)
	}
	return conn, func() {
		_ = conn.Close()
		ts.Close()
	}
}

func sendProtoFrame(t *testing.T, conn *websocket.Conn, frame proto.Message) {
	t.Helper()
	data, err := proto.Marshal(frame)
	if err != nil {
		t.Fatalf("marshal v2 frame: %v", err)
	}
	if err := conn.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set v2 write deadline: %v", err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
		t.Fatalf("send v2 frame: %v", err)
	}
}

// receiveWebFrame 读取一条 WebServerFrame，跳过与断言无关的周期/广播帧（对应 v1 harness
// 过滤集）；带关联 id 的 status 是 status_get / chat_prepare 的响应，不过滤。
func receiveWebFrame(t *testing.T, conn *websocket.Conn) *gatewayv2.WebServerFrame {
	t.Helper()
	for {
		frame := receiveWebFrameRaw(t, conn)
		switch frame.GetPayload().(type) {
		case *gatewayv2.WebServerFrame_Ping,
			*gatewayv2.WebServerFrame_TunnelState,
			*gatewayv2.WebServerFrame_ProcessState:
			continue
		case *gatewayv2.WebServerFrame_Status:
			if frame.GetRequestId() == "" {
				continue
			}
			return frame
		default:
			return frame
		}
	}
}

func receiveWebFrameRaw(t *testing.T, conn *websocket.Conn) *gatewayv2.WebServerFrame {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set v2 read deadline: %v", err)
	}
	messageType, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("receive v2 frame: %v", err)
	}
	if messageType != websocket.BinaryMessage {
		t.Fatalf("v2 frame message type = %d, want binary", messageType)
	}
	var frame gatewayv2.WebServerFrame
	if err := proto.Unmarshal(data, &frame); err != nil {
		t.Fatalf("unmarshal v2 frame: %v", err)
	}
	return &frame
}

// receiveWebFrameWithID 等待携带指定关联 id 的帧。
func receiveWebFrameWithID(t *testing.T, conn *websocket.Conn, id string) *gatewayv2.WebServerFrame {
	t.Helper()
	for attempt := 0; attempt < 8; attempt++ {
		frame := receiveWebFrame(t, conn)
		if frame.GetRequestId() == id {
			return frame
		}
	}
	t.Fatalf("timed out waiting for v2 frame id %q", id)
	return nil
}

// helloV2 完成浏览器链路握手并断言成功。
func helloV2(t *testing.T, conn *websocket.Conn, token string) {
	t.Helper()
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "hello-1",
		Payload: &gatewayv2.WebClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Role:            gatewayv2.ClientRole_CLIENT_ROLE_BROWSER,
				Token:           token,
				ClientName:      "webui-test",
			},
		},
	})
	frame := receiveWebFrameRaw(t, conn)
	hello := frame.GetHello()
	if hello == nil || !hello.GetOk() {
		t.Fatalf("v2 hello reply = %#v, want ok hello", frame)
	}
}

// newV2BrowserTest 建好 manager + 假 agent 会话 + 已握手的浏览器连接。
func newV2BrowserTest(t *testing.T) (*session.Manager, *session.AgentSession, *websocket.Conn, func()) {
	t.Helper()

	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := pbws.NewServer(newV2TestConfig(), sm).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	helloV2(t, conn, "ws-token")
	return sm, agentSession, conn, cleanup
}
