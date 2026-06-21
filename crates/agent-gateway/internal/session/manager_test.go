package session

import (
	"testing"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func TestApplySettingsJSONPreservingRemoteKeepsDesktopTerminalSetting(t *testing.T) {
	manager := NewManager()
	manager.ApplySettingsJSON(`{"remote":{"enableWebTerminal":true,"enableWebSshTerminal":true},"theme":"dark"}`)
	if !manager.WebTerminalEnabled() {
		t.Fatal("expected desktop settings sync to enable web terminal")
	}
	if !manager.WebSshTerminalEnabled() {
		t.Fatal("expected desktop settings sync to enable web SSH terminal")
	}

	manager.ApplySettingsJSONPreservingRemote(`{"remote":{"enableWebTerminal":false,"enableWebSshTerminal":false},"theme":"light"}`)
	if !manager.WebTerminalEnabled() {
		t.Fatal("settings.update must not disable the desktop-owned web terminal setting")
	}
	if !manager.WebSshTerminalEnabled() {
		t.Fatal("settings.update must not disable the desktop-owned web SSH terminal setting")
	}
}

func TestApplySettingsJSONKeepsRemoteWhenPublicSettingsEventOmitsIt(t *testing.T) {
	manager := NewManager()
	manager.ApplySettingsJSON(`{"remote":{"enableWebTerminal":true,"enableWebSshTerminal":true},"theme":"dark"}`)
	if !manager.WebTerminalEnabled() {
		t.Fatal("expected desktop settings sync to enable web terminal")
	}
	if !manager.WebSshTerminalEnabled() {
		t.Fatal("expected desktop settings sync to enable web SSH terminal")
	}

	manager.ApplySettingsJSON(`{"theme":"light"}`)
	if !manager.WebTerminalEnabled() {
		t.Fatal("public settings events without remote must not clear the desktop web terminal setting")
	}
	if !manager.WebSshTerminalEnabled() {
		t.Fatal("public settings events without remote must not clear the desktop web SSH terminal setting")
	}
}

func TestApplySettingsJSONPreservingRemoteDoesNotTrustIncomingRemote(t *testing.T) {
	manager := NewManager()
	manager.ApplySettingsJSONPreservingRemote(`{"remote":{"enableWebTerminal":true,"enableWebSshTerminal":true}}`)
	if manager.WebTerminalEnabled() {
		t.Fatal("settings.update must not enable web terminal without a desktop settings snapshot")
	}
	if manager.WebSshTerminalEnabled() {
		t.Fatal("settings.update must not enable web SSH terminal without a desktop settings snapshot")
	}
}

func TestTerminalSessionSnapshotPreservesSshMetadataAndSorts(t *testing.T) {
	manager := NewManager()
	manager.ReplaceTerminalSessionSnapshot("", []*gatewayv1.TerminalSession{
		{
			Id:             "ssh-2",
			ProjectPathKey: "/workspace/b",
			Cwd:            "/workspace/b",
			Shell:          "ssh",
			Title:          "Production 2",
			Kind:           "ssh",
			CreatedAt:      2,
			UpdatedAt:      2,
			Running:        true,
			Ssh: &gatewayv1.TerminalSshMetadata{
				HostId:   "prod-2",
				HostName: "Production 2",
				Username: "deploy",
				Host:     "prod-2.example.com",
				Port:     22,
				AuthType: "privateKey",
			},
		},
		{
			Id:             "local-1",
			ProjectPathKey: "/workspace/a",
			Cwd:            "/workspace/a",
			Shell:          "zsh",
			Title:          "Local",
			Kind:           "local",
			CreatedAt:      2,
			UpdatedAt:      2,
			Running:        true,
		},
		{
			Id:             "ssh-1",
			ProjectPathKey: "/workspace/a",
			Cwd:            "/workspace/a",
			Shell:          "ssh",
			Title:          "Production",
			Kind:           "ssh",
			CreatedAt:      1,
			UpdatedAt:      1,
			Running:        true,
			Ssh: &gatewayv1.TerminalSshMetadata{
				HostId:   "prod",
				HostName: "Production",
				Username: "deploy",
				Host:     "prod.example.com",
				Port:     22,
				AuthType: "password",
			},
		},
	})

	sessions := manager.TerminalSessionSnapshot("")
	if len(sessions) != 3 {
		t.Fatalf("terminal sessions = %d, want 3", len(sessions))
	}
	if got := []string{sessions[0].GetId(), sessions[1].GetId(), sessions[2].GetId()}; got[0] != "ssh-1" || got[1] != "local-1" || got[2] != "ssh-2" {
		t.Fatalf("terminal session order = %#v", got)
	}
	if manager.TerminalSessionKind("ssh-1") != "ssh" {
		t.Fatalf("TerminalSessionKind(ssh-1) = %q, want ssh", manager.TerminalSessionKind("ssh-1"))
	}
	if sessions[0].GetSsh().GetHostId() != "prod" || sessions[0].GetSsh().GetAuthType() != "password" {
		t.Fatalf("ssh metadata = %#v", sessions[0].GetSsh())
	}

	sessions[0].Ssh.HostId = "mutated"
	fresh := manager.TerminalSessionSnapshot("/workspace/a")
	if len(fresh) != 2 {
		t.Fatalf("filtered terminal sessions = %d, want 2", len(fresh))
	}
	if fresh[0].GetSsh().GetHostId() != "prod" {
		t.Fatalf("terminal snapshot should be immutable, got ssh host id %q", fresh[0].GetSsh().GetHostId())
	}
}

func TestAppendCappedChatRunEventKeepsLatestEvents(t *testing.T) {
	var events []*ChatBroadcastEvent
	for seq := int64(1); seq <= 5; seq++ {
		events = appendCappedChatRunEvent(events, &ChatBroadcastEvent{Seq: seq}, 3)
	}

	if len(events) != 3 {
		t.Fatalf("events len = %d, want 3", len(events))
	}
	if got := []int64{events[0].Seq, events[1].Seq, events[2].Seq}; got[0] != 3 || got[1] != 4 || got[2] != 5 {
		t.Fatalf("events seqs = %#v, want [3 4 5]", got)
	}

	events = appendCappedChatRunEvent(events, nil, 3)
	if got := []int64{events[0].Seq, events[1].Seq, events[2].Seq}; got[0] != 3 || got[1] != 4 || got[2] != 5 {
		t.Fatalf("nil event changed buffered seqs to %#v, want [3 4 5]", got)
	}
}

func TestChatRunShouldPruneRetainsRunningUntilStale(t *testing.T) {
	now := time.Now()
	running := &chatRun{
		state:     ChatRunStateRunning,
		updatedAt: now.Add(-(chatRunStartRetention + time.Second)),
	}
	if running.shouldPrune(now) {
		t.Fatal("running chat should survive the start retention window")
	}

	queued := &chatRun{
		state:     ChatRunStateQueued,
		updatedAt: now.Add(-(chatRunStartRetention + time.Second)),
	}
	if !queued.shouldPrune(now) {
		t.Fatal("unstarted queued chat should prune after start retention")
	}

	done := &chatRun{
		done:      true,
		expiresAt: now.Add(-time.Second),
	}
	if !done.shouldPrune(now) {
		t.Fatal("done chat should prune after expiresAt")
	}
}

func TestPruneExpiredChatRunsDropsNilEntries(t *testing.T) {
	manager := NewManager()
	manager.chatStore.chatMu.Lock()
	manager.chatStore.chatRuns["nil-run"] = nil
	manager.pruneExpiredChatRunsLocked(time.Now())
	_, exists := manager.chatStore.chatRuns["nil-run"]
	manager.chatStore.chatMu.Unlock()

	if exists {
		t.Fatal("nil chat run should be deleted during pruning")
	}
}
