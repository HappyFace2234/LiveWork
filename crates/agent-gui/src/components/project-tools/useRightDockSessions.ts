import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RightDockProjectState, RightDockTabInstance } from "../../lib/settings";
import type {
  TerminalClient,
  TerminalSession,
  TerminalShellOption,
  TerminalSnapshot,
} from "../../lib/terminal/types";
import {
  areSessionsEqual,
  createRightDockTerminalTab,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  sameRightDockOrder,
  sortSessions,
  terminalSessionBelongsToProject,
} from "./rightDockModel";

type UseRightDockSessionsOptions = {
  client: TerminalClient;
  cwd: string;
  externalSessions?: TerminalSession[];
  isOpen: boolean;
  projectPathKey: string;
  projectState: RightDockProjectState;
  terminalReady: boolean;
  onProjectStateChange: (
    updater: (current: RightDockProjectState) => RightDockProjectState,
  ) => void;
  onSessionsChange?: (sessions: TerminalSession[]) => void;
};

export function useRightDockSessions(options: UseRightDockSessionsOptions) {
  const {
    client,
    cwd,
    externalSessions,
    isOpen,
    onProjectStateChange,
    onSessionsChange,
    projectPathKey,
    projectState,
    terminalReady,
  } = options;
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [closingSessionId, setClosingSessionId] = useState("");
  const [pendingCloseSessionId, setPendingCloseSessionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shellOptions, setShellOptions] = useState<TerminalShellOption[]>([]);
  const initialTerminalSnapshotsRef = useRef<Map<string, TerminalSnapshot>>(new Map());
  const lastProjectPathKeyRef = useRef(projectPathKey);
  const isControlled = externalSessions !== undefined;
  const localSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          session.kind !== "ssh" && terminalSessionBelongsToProject(session, projectPathKey),
      ),
    [projectPathKey, sessions],
  );
  const sshSessions = useMemo(
    () => sessions.filter((session) => session.kind === "ssh"),
    [sessions],
  );
  const activeSession = useMemo(
    () =>
      localSessions.find((session) => session.id === projectState.activeTabId) ??
      localSessions.find((session) => session.id === activeSessionId) ??
      localSessions[0] ??
      null,
    [activeSessionId, localSessions, projectState.activeTabId],
  );
  const pendingCloseSession = useMemo(
    () => localSessions.find((session) => session.id === pendingCloseSessionId) ?? null,
    [localSessions, pendingCloseSessionId],
  );

  const publishSessions = useCallback(
    (nextSessions: TerminalSession[], options?: { notifyParent?: boolean }) => {
      const sorted = sortSessions(nextSessions);
      setSessions(sorted);
      if (options?.notifyParent !== false) {
        onSessionsChange?.(sorted);
      }
      setActiveSessionId((current) => {
        if (current && sorted.some((session) => session.id === current)) return current;
        return sorted[0]?.id ?? "";
      });
    },
    [onSessionsChange],
  );

  const activateTerminalSession = useCallback(
    (session: TerminalSession) => {
      setActiveSessionId(session.id);
      onProjectStateChange((current) => {
        const tab = createRightDockTerminalTab(session, projectPathKey);
        const existing = current.tabs[session.id];
        const tabs =
          existing?.title === tab.title && existing?.createdAt === tab.createdAt
            ? current.tabs
            : { ...current.tabs, [session.id]: tab };
        const tabOrder = current.tabOrder.includes(session.id)
          ? current.tabOrder
          : [...current.tabOrder, session.id];
        if (
          current.activeTabId === session.id &&
          tabs === current.tabs &&
          tabOrder === current.tabOrder
        ) {
          return current;
        }
        return {
          ...current,
          activeTabId: session.id,
          tabOrder,
          tabs,
          stateVersion: current.stateVersion + 1,
        };
      });
    },
    [onProjectStateChange, projectPathKey],
  );

  useEffect(() => {
    const activeTerminalSession = localSessions.find(
      (session) => session.id === projectState.activeTabId,
    );
    if (activeTerminalSession) {
      setActiveSessionId(activeTerminalSession.id);
    }
  }, [localSessions, projectState.activeTabId]);

  useEffect(() => {
    if (!projectPathKey) return;
    onProjectStateChange((current) => {
      const liveTerminalIds = new Set(localSessions.map((session) => session.id));
      let changed = false;
      const tabs: Record<string, RightDockTabInstance> = {};

      for (const [tabId, tab] of Object.entries(current.tabs)) {
        if (tab.kind === "terminal" && !liveTerminalIds.has(tabId)) {
          changed = true;
          continue;
        }
        tabs[tabId] = tab;
      }

      for (const session of localSessions) {
        const nextTab = createRightDockTerminalTab(session, projectPathKey);
        const currentTab = tabs[session.id];
        if (
          !currentTab ||
          currentTab.title !== nextTab.title ||
          currentTab.createdAt !== nextTab.createdAt
        ) {
          tabs[session.id] = nextTab;
          changed = true;
        }
      }

      const tabOrder = current.tabOrder.filter((id) => tabs[id]);
      for (const session of localSessions) {
        if (!tabOrder.includes(session.id)) tabOrder.push(session.id);
      }
      for (const id of Object.keys(tabs)) {
        if (!tabOrder.includes(id)) tabOrder.push(id);
      }
      if (!sameRightDockOrder(current.tabOrder, tabOrder)) changed = true;

      const activeTabId =
        current.activeTabId && tabs[current.activeTabId]
          ? current.activeTabId
          : activeSessionId && tabs[activeSessionId]
            ? activeSessionId
            : tabOrder[0];
      if ((current.activeTabId ?? "") !== (activeTabId ?? "")) changed = true;

      if (!changed) return current;
      return {
        openVersion: current.openVersion,
        ...(activeTabId ? { activeTabId } : {}),
        tabOrder,
        tabs,
        stateVersion: current.stateVersion + 1,
      };
    });
  }, [activeSessionId, localSessions, onProjectStateChange, projectPathKey]);

  useEffect(() => {
    if (!externalSessions) return;
    const sorted = sortSessions(externalSessions);
    setSessions((current) => (areSessionsEqual(current, sorted) ? current : sorted));
    setActiveSessionId((current) => {
      if (current && sorted.some((session) => session.id === current)) return current;
      return sorted[0]?.id ?? "";
    });
  }, [externalSessions]);

  const refreshSessions = useCallback(() => {
    if (!terminalReady) {
      publishSessions([], { notifyParent: false });
      return;
    }
    setLoading(true);
    setError(null);
    void client
      .list()
      .then((nextSessions) => {
        publishSessions(nextSessions, { notifyParent: !isControlled });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [client, isControlled, publishSessions, terminalReady]);

  useEffect(() => {
    if (!isOpen || isControlled) return;
    refreshSessions();
  }, [isControlled, isOpen, refreshSessions]);

  useEffect(() => {
    if (!terminalReady) {
      setShellOptions([]);
      return;
    }
    let cancelled = false;
    void client
      .shellOptions()
      .then((response) => {
        if (cancelled) return;
        setShellOptions(response.options);
      })
      .catch(() => {
        if (!cancelled) {
          setShellOptions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, terminalReady]);

  useEffect(() => {
    if (!terminalReady || isControlled) return;
    return client.subscribe((event) => {
      if (event.kind === "output") return;
      setSessions((current) => {
        let next = current;
        if (event.kind === "closed") {
          next = current.filter((session) => session.id !== event.sessionId);
        } else {
          const index = current.findIndex((session) => session.id === event.sessionId);
          if (index >= 0) {
            next = [...current];
            next[index] = event.session;
          } else if (event.kind === "created") {
            next = [...current, event.session];
          }
        }
        const sorted = sortSessions(next);
        onSessionsChange?.(sorted);
        return sorted;
      });
    });
  }, [client, isControlled, onSessionsChange, projectPathKey, terminalReady]);

  useEffect(() => {
    if (lastProjectPathKeyRef.current === projectPathKey) return;
    lastProjectPathKeyRef.current = projectPathKey;
    initialTerminalSnapshotsRef.current.clear();
    setPendingCloseSessionId("");
    setClosingSessionId("");
  }, [projectPathKey]);

  useEffect(() => {
    if (!pendingCloseSessionId) return;
    if (!localSessions.some((session) => session.id === pendingCloseSessionId)) {
      setPendingCloseSessionId("");
    }
  }, [localSessions, pendingCloseSessionId]);

  const rememberTerminalSnapshot = useCallback(
    (snapshot: TerminalSnapshot) => {
      initialTerminalSnapshotsRef.current.set(snapshot.session.id, snapshot);
      setSessions((current) => {
        const next = sortSessions([
          ...current.filter((session) => session.id !== snapshot.session.id),
          snapshot.session,
        ]);
        onSessionsChange?.(next);
        return next;
      });
    },
    [onSessionsChange],
  );

  const reconcileSshSessions = useCallback(
    (nextSshSessions: TerminalSession[]) => {
      const normalizedSshSessions = nextSshSessions.filter(
        (session) => session.kind === "ssh" && session.id,
      );
      setSessions((current) => {
        const nextSshSessionIds = new Set(normalizedSshSessions.map((session) => session.id));
        const next = sortSessions([
          ...current.filter((session) => session.kind !== "ssh"),
          ...normalizedSshSessions,
        ]);
        if (areSessionsEqual(current, next)) return current;
        for (const session of current) {
          if (session.kind === "ssh" && !nextSshSessionIds.has(session.id)) {
            initialTerminalSnapshotsRef.current.delete(session.id);
          }
        }
        onSessionsChange?.(next);
        return next;
      });
    },
    [onSessionsChange],
  );

  const forgetTerminalSession = useCallback(
    (sessionId: string) => {
      initialTerminalSnapshotsRef.current.delete(sessionId);
      setPendingCloseSessionId((current) => (current === sessionId ? "" : current));
      setSessions((current) => {
        const next = sortSessions(current.filter((item) => item.id !== sessionId));
        onSessionsChange?.(next);
        return next;
      });
    },
    [onSessionsChange],
  );

  const createTerminal = useCallback(
    (shell?: string) => {
      if (!terminalReady || creating) return;
      setCreating(true);
      setError(null);
      void client
        .create({
          cwd,
          projectPathKey,
          shell: shell?.trim() || undefined,
          cols: DEFAULT_TERMINAL_COLS,
          rows: DEFAULT_TERMINAL_ROWS,
        })
        .then((snapshot) => {
          rememberTerminalSnapshot(snapshot);
          activateTerminalSession(snapshot.session);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setCreating(false));
    },
    [
      activateTerminalSession,
      client,
      creating,
      cwd,
      projectPathKey,
      rememberTerminalSnapshot,
      terminalReady,
    ],
  );

  const closeSession = useCallback(
    (session: TerminalSession) => {
      if (closingSessionId === session.id) return;
      setError(null);
      setClosingSessionId(session.id);
      void client
        .close(session.id, session.projectPathKey)
        .then(() => {
          forgetTerminalSession(session.id);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setClosingSessionId((current) => (current === session.id ? "" : current)));
    },
    [client, closingSessionId, forgetTerminalSession],
  );

  const handleCloseRequest = useCallback(
    (session: TerminalSession) => {
      setError(null);
      if (session.running && pendingCloseSessionId !== session.id) {
        activateTerminalSession(session);
        setPendingCloseSessionId(session.id);
        return;
      }
      closeSession(session);
    },
    [activateTerminalSession, closeSession, pendingCloseSessionId],
  );

  const handleInitialTerminalSnapshotConsumed = useCallback((sessionId: string) => {
    initialTerminalSnapshotsRef.current.delete(sessionId);
  }, []);

  const clearPendingCloseSession = useCallback(() => {
    setPendingCloseSessionId("");
  }, []);

  return {
    activateTerminalSession,
    activeSession,
    clearPendingCloseSession,
    closeSession,
    closingSessionId,
    createTerminal,
    creating,
    error,
    forgetTerminalSession,
    handleCloseRequest,
    handleInitialTerminalSnapshotConsumed,
    initialTerminalSnapshotsRef,
    loading,
    localSessions,
    pendingCloseSession,
    pendingCloseSessionId,
    reconcileSshSessions,
    rememberTerminalSnapshot,
    setError,
    shellOptions,
    sshSessions,
  };
}
