// Deprecated: v1 JSON 协议的处理器/载荷塑形，已被 v2 信封直通（internal/protocol/pbws）取代；仅为旧客户端保留，流量归零后整体删除。
package server

import (
	"strings"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
)

func terminalActionFromRequestType(requestType string) string {
	return strings.TrimPrefix(strings.TrimSpace(requestType), "terminal.")
}

// Terminal gating and response post-processing live in
// internal/protocol/shared (shared with the v2 protocol); the methods below
// are thin v1 adapters.

func (c *websocketConnection) terminalFeaturesEnabled() bool {
	return shared.TerminalFeaturesEnabled(c.sm)
}

func (c *websocketConnection) terminalSessionAllowed(session *gatewayv1.TerminalSession) bool {
	return shared.TerminalSessionAllowed(c.sm, session)
}

func (c *websocketConnection) terminalEventAllowed(event *gatewayv1.TerminalEvent) bool {
	return shared.TerminalEventAllowed(c.sm, event)
}

func (c *websocketConnection) handleTerminalRequest(req websocketRequest) {
	action := terminalActionFromRequestType(req.Type)

	var body websocketTerminalRequestPayload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid "+req.Type+" payload")
		return
	}
	if !shared.TerminalRequestAllowed(c.sm, action, strings.TrimSpace(body.SessionID)) {
		_ = c.writeError(req.ID, shared.TerminalPermissionError(action))
		return
	}

	cols, err := websocketOptionalUint32(body.Cols, "cols")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}
	rows, err := websocketOptionalUint32(body.Rows, "rows")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}
	maxBytes, err := websocketOptionalUint32(body.MaxBytes, "max_bytes")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}
	projectPathKey := strings.TrimSpace(body.ProjectPathKey)

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_TerminalRequest{
			TerminalRequest: &gatewayv1.TerminalRequest{
				Action:         action,
				SessionId:      strings.TrimSpace(body.SessionID),
				ProjectPathKey: projectPathKey,
				Cwd:            strings.TrimSpace(body.Cwd),
				Shell:          strings.TrimSpace(body.Shell),
				Title:          strings.TrimSpace(body.Title),
				Data:           body.Data,
				Cols:           cols,
				Rows:           rows,
				MaxBytes:       maxBytes,
				SshHostId:      strings.TrimSpace(body.SshHostID),
				PromptId:       strings.TrimSpace(body.PromptID),
				PromptAnswer:   body.PromptAnswer,
				TrustHostKey:   body.TrustHostKey,
				SftpEnabled:    body.SftpEnabled,
				TabId:          strings.TrimSpace(body.TabID),
				TabKind:        strings.TrimSpace(body.TabKind),
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetTerminalResponse()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}
	filteredResp := shared.FinalizeTerminalResponse(c.sm, c.terminalInterest, action, projectPathKey, resp)

	_ = c.writeResponse(req.ID, websocketTerminalResponsePayload(filteredResp))
}
