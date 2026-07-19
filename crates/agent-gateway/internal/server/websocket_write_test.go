package server

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/transport/wscore"
)

// 写泵队列语义（等待/掉帧/关闭/心跳静默丢弃）测试已随运行时抽取移至 internal/transport/wscore/conn_test.go；本文件只测 v1 层职责：信封到帧类别的分类与包装后的关键端到端行为。

func newEnqueueTestConnection(outboxSize int, writeTimeout time.Duration) *websocketConnection {
	core := wscore.NewConn(nil, wscore.Config{
		QueueSize:    outboxSize,
		WriteTimeout: writeTimeout,
	})
	return &websocketConnection{core: core, done: core.Done()}
}

func TestClassifyEnvelope(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		envelope websocketEnvelope
		want     wscore.FrameClass
	}{
		{"ping", websocketEnvelope{Type: "ping"}, wscore.FramePing},
		{"error", websocketEnvelope{Type: "error"}, wscore.FrameControl},
		{"subscription reset", websocketEnvelope{Type: "chat.subscription_reset"}, wscore.FrameControl},
		{"command update", websocketEnvelope{Type: "chat.command_update"}, wscore.FrameControl},
		{"priority response", websocketEnvelope{ID: "r1", Type: "response", priority: true}, wscore.FrameControl},
		{"correlated response", websocketEnvelope{ID: "r1", Type: "response"}, wscore.FrameResponse},
		{"uncorrelated response", websocketEnvelope{Type: "response"}, wscore.FrameData},
		{"event", websocketEnvelope{Type: "chat.event"}, wscore.FrameData},
	}
	for _, tc := range cases {
		if got := classifyEnvelope(tc.envelope); got != tc.want {
			t.Fatalf("classifyEnvelope(%s) = %d, want %d", tc.name, got, tc.want)
		}
	}
}

func TestWriteEnvelopeRoutesControlTypesToControlQueue(t *testing.T) {
	t.Parallel()

	c := newEnqueueTestConnection(1, 50*time.Millisecond)

	for _, envelopeType := range []string{"ping", "error", "chat.subscription_reset", "chat.command_update"} {
		if err := c.writeEnvelope(websocketEnvelope{Type: envelopeType}); err != nil {
			t.Fatalf("writeEnvelope(%q) = %v, want nil", envelopeType, err)
		}
	}
	if got := len(c.core.CtrlOutbox); got != 4 {
		t.Fatalf("control queue depth = %d, want 4", got)
	}
	if got := len(c.core.Outbox); got != 0 {
		t.Fatalf("data queue depth = %d, want 0", got)
	}

	if err := c.writeEnvelope(websocketEnvelope{Type: "chat.event"}); err != nil {
		t.Fatalf("writeEnvelope(chat.event) = %v, want nil", err)
	}
	if got := len(c.core.Outbox); got != 1 {
		t.Fatalf("data queue depth after chat.event = %d, want 1", got)
	}
}

func TestWritePriorityResponseUsesControlQueue(t *testing.T) {
	t.Parallel()

	c := newEnqueueTestConnection(1, 50*time.Millisecond)
	c.core.Outbox <- wscore.Frame{Kind: "chat.event"}

	if err := c.writePriorityResponse("cmd-1", map[string]any{"run_id": "run-1"}); err != nil {
		t.Fatalf("writePriorityResponse: %v", err)
	}
	select {
	case frame := <-c.core.CtrlOutbox:
		if frame.Class != wscore.FrameControl || frame.RequestID != "cmd-1" || frame.Kind != "response" {
			t.Fatalf("priority response frame = %#v", frame)
		}
		var envelope struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		}
		if err := json.Unmarshal(frame.Data, &envelope); err != nil {
			t.Fatalf("decode priority response frame: %v", err)
		}
		if envelope.ID != "cmd-1" || envelope.Type != "response" {
			t.Fatalf("priority response envelope = %#v", envelope)
		}
	default:
		t.Fatal("priority response was not routed to the control queue")
	}
}

func TestWriteEnvelopeQueueFullDoesNotCloseConnection(t *testing.T) {
	t.Parallel()

	c := newEnqueueTestConnection(1, 20*time.Millisecond)
	c.core.Outbox <- wscore.Frame{Kind: "chat.event"}

	err := c.writeEnvelope(websocketEnvelope{Type: "chat.event"})
	if !errors.Is(err, errWriteQueueFull) {
		t.Fatalf("writeEnvelope with stuck outbox = %v, want errWriteQueueFull", err)
	}
	select {
	case <-c.done:
		t.Fatal("writeEnvelope closed the connection on a full data queue")
	default:
	}
	if got := c.core.DroppedFrames(); got != 1 {
		t.Fatalf("DroppedFrames = %d, want 1", got)
	}
}

func TestWriteResponseQueueFullClosesConnectionForRecovery(t *testing.T) {
	t.Parallel()

	c := newEnqueueTestConnection(1, 20*time.Millisecond)
	c.core.Outbox <- wscore.Frame{Kind: "chat.event"}

	err := c.writeResponse("history-1", map[string]any{"total_count": 1})
	if !errors.Is(err, errWriteQueueFull) {
		t.Fatalf("writeResponse with stuck outbox = %v, want errWriteQueueFull", err)
	}
	select {
	case <-c.done:
		// Expected: the client observes a disconnect and can recover the
		// correlated request instead of waiting for a silently dropped reply.
	default:
		t.Fatal("writeResponse left the connection open after dropping a correlated response")
	}
}
