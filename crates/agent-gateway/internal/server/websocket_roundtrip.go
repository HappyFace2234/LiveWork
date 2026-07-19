// Deprecated: v1 JSON 协议的处理器/载荷塑形，已被 v2 信封直通（internal/protocol/pbws）取代；仅为旧客户端保留，流量归零后整体删除。
package server

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

func decodeWebSocketPayload(raw json.RawMessage, target any) error {
	if len(raw) == 0 {
		return json.Unmarshal([]byte("{}"), target)
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func awaitAgentUnaryResponse(
	ctx context.Context,
	sm *session.Manager,
	requestID string,
	envelope *gatewayv1.GatewayEnvelope,
) (*gatewayv1.AgentEnvelope, error) {
	return sm.AwaitUnaryResponse(ctx, requestID, envelope)
}

func websocketErrorMessage(err error) string {
	if err == nil {
		return "request failed"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "request timed out"
	}
	if errors.Is(err, context.Canceled) {
		return "request canceled"
	}
	if errors.Is(err, session.ErrAgentOffline) {
		return "agent offline"
	}
	return err.Error()
}

func requireTrimmedWebSocketString(value string, field string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", errors.New(field + " is required")
	}
	return trimmed, nil
}
