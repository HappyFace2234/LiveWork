package server

import (
	"errors"
	"testing"
	"time"
)

func newEnqueueTestConnection(outboxSize int, writeTimeout time.Duration) *websocketConnection {
	return &websocketConnection{
		outbox:       make(chan websocketEnvelope, outboxSize),
		writeTimeout: writeTimeout,
		done:         make(chan struct{}),
	}
}

func TestEnqueueEnvelopeWaitsForDrainedSlot(t *testing.T) {
	t.Parallel()

	c := newEnqueueTestConnection(1, 500*time.Millisecond)
	c.outbox <- websocketEnvelope{Type: "ping"}

	go func() {
		time.Sleep(10 * time.Millisecond)
		<-c.outbox
	}()

	if err := c.enqueueEnvelope(websocketEnvelope{Type: "chat.event"}); err != nil {
		t.Fatalf("enqueueEnvelope with draining outbox = %v, want nil", err)
	}
}

func TestEnqueueEnvelopeFailsAfterPersistentBacklog(t *testing.T) {
	t.Parallel()

	c := newEnqueueTestConnection(1, 50*time.Millisecond)
	c.outbox <- websocketEnvelope{Type: "ping"}

	started := time.Now()
	err := c.enqueueEnvelope(websocketEnvelope{Type: "chat.event"})
	if !errors.Is(err, errWriteQueueFull) {
		t.Fatalf("enqueueEnvelope with stuck outbox = %v, want errWriteQueueFull", err)
	}
	if waited := time.Since(started); waited < 50*time.Millisecond {
		t.Fatalf("enqueueEnvelope gave up after %s, want at least the 50ms write timeout", waited)
	}
}

func TestEnqueueEnvelopeReturnsWhenConnectionCloses(t *testing.T) {
	t.Parallel()

	c := newEnqueueTestConnection(1, time.Second)
	c.outbox <- websocketEnvelope{Type: "ping"}

	go func() {
		time.Sleep(10 * time.Millisecond)
		close(c.done)
	}()

	err := c.enqueueEnvelope(websocketEnvelope{Type: "chat.event"})
	if err == nil || err.Error() != "connection closed" {
		t.Fatalf("enqueueEnvelope on closed connection = %v, want connection closed", err)
	}
}
