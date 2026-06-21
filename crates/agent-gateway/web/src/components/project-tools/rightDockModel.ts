import {
  RIGHT_DOCK_SINGLETON_TAB_IDS,
  type RightDockProjectState,
  type RightDockTabInstance,
  type RightDockTabKind,
  workspaceProjectPathKey,
} from "@/lib/settings";
import type { TerminalSession } from "@/lib/terminal/types";

export const MIN_RIGHT_DOCK_PANEL_WIDTH = 320;
export const DEFAULT_RIGHT_DOCK_MAX_PANEL_WIDTH = 720;
export const ABSOLUTE_RIGHT_DOCK_MAX_PANEL_WIDTH = 1280;
export const MIN_RIGHT_DOCK_MAIN_CONTENT_WIDTH = 420;
export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;
export const FILE_TREE_TAB_ID = RIGHT_DOCK_SINGLETON_TAB_IDS.fileTree;
export const GIT_REVIEW_TAB_ID = RIGHT_DOCK_SINGLETON_TAB_IDS.gitReview;
export const TUNNEL_TAB_ID = RIGHT_DOCK_SINGLETON_TAB_IDS.tunnel;
export const SSH_TUNNEL_TAB_ID = RIGHT_DOCK_SINGLETON_TAB_IDS.sshTunnel;
export const PROJECT_TOOLS_RESIZE_END_EVENT = "liveagent:project-tools-resize-end";

export type RightDockSingletonTabKind = Exclude<RightDockTabKind, "terminal">;

export const RIGHT_DOCK_SINGLETON_TAB_KINDS: readonly RightDockSingletonTabKind[] = [
  "fileTree",
  "gitReview",
  "tunnel",
  "sshTunnel",
];

export type RightDockVisibleTab =
  | {
      id: string;
      kind: "terminal";
      session: TerminalSession;
    }
  | {
      id: string;
      kind: RightDockSingletonTabKind;
    };

export function sortSessions(sessions: TerminalSession[]) {
  return [...sessions].sort((a, b) => a.createdAt - b.createdAt);
}

export function areSessionsEqual(left: TerminalSession[], right: TerminalSession[]) {
  if (left.length !== right.length) return false;
  return left.every((session, index) => {
    const other = right[index];
    return (
      other &&
      session.id === other.id &&
      session.projectPathKey === other.projectPathKey &&
      session.cwd === other.cwd &&
      session.shell === other.shell &&
      session.title === other.title &&
      session.kind === other.kind &&
      (session.ssh?.hostId ?? "") === (other.ssh?.hostId ?? "") &&
      (session.ssh?.hostName ?? "") === (other.ssh?.hostName ?? "") &&
      (session.ssh?.username ?? "") === (other.ssh?.username ?? "") &&
      (session.ssh?.host ?? "") === (other.ssh?.host ?? "") &&
      (session.ssh?.port ?? 0) === (other.ssh?.port ?? 0) &&
      (session.ssh?.authType ?? "") === (other.ssh?.authType ?? "") &&
      (session.ssh?.status ?? "") === (other.ssh?.status ?? "") &&
      (session.ssh?.reconnectAttempt ?? 0) === (other.ssh?.reconnectAttempt ?? 0) &&
      (session.ssh?.reconnectMaxAttempts ?? 0) ===
        (other.ssh?.reconnectMaxAttempts ?? 0) &&
      session.pid === other.pid &&
      session.cols === other.cols &&
      session.rows === other.rows &&
      session.createdAt === other.createdAt &&
      session.updatedAt === other.updatedAt &&
      session.finishedAt === other.finishedAt &&
      session.exitCode === other.exitCode &&
      session.running === other.running
    );
  });
}

export function formatTerminalSessionTitle(title: string, terminalLabel: string) {
  const match = /^Terminal(?:\s+(\d+))?$/.exec(title.trim());
  if (!match) return title;
  return match[1] ? `${terminalLabel} ${match[1]}` : terminalLabel;
}

export function terminalSessionBelongsToProject(session: TerminalSession, projectPathKey: string) {
  const wantedProjectKey = workspaceProjectPathKey(projectPathKey);
  if (!wantedProjectKey) return false;
  const sessionProjectKey = workspaceProjectPathKey(session.projectPathKey || session.cwd);
  return sessionProjectKey === wantedProjectKey;
}

export function dirname(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

export function expandedPathsForFileTreePath(path: string) {
  const normalized = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/").filter(Boolean);
  const dirs = parts.slice(0, -1);
  return ["", ...dirs.map((_, index) => parts.slice(0, index + 1).join("/"))];
}

export function tabOrderIdsEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function orderRightDockVisibleTabs(
  tabs: RightDockVisibleTab[],
  tabOrder: readonly string[],
) {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const used = new Set<string>();
  const ordered: RightDockVisibleTab[] = [];
  for (const id of tabOrder) {
    const tab = byId.get(id);
    if (!tab || used.has(id)) continue;
    used.add(id);
    ordered.push(tab);
  }
  for (const tab of tabs) {
    if (used.has(tab.id)) continue;
    ordered.push(tab);
  }
  return ordered;
}

export function rightDockTabRequiresProject(kind: RightDockSingletonTabKind) {
  return kind !== "tunnel";
}

export function getRightDockVisibleTabs(options: {
  localSessions: TerminalSession[];
  projectPathKey: string;
  projectState: RightDockProjectState;
  tunnelAvailable: boolean;
}) {
  const { localSessions, projectPathKey, projectState, tunnelAvailable } = options;
  const terminalTabs: RightDockVisibleTab[] = localSessions.map((session) => ({
    id: session.id,
    kind: "terminal",
    session,
  }));
  const nextTabs: RightDockVisibleTab[] = [...terminalTabs];
  for (const kind of RIGHT_DOCK_SINGLETON_TAB_KINDS) {
    const id = rightDockSingletonTabId(kind);
    const tab = projectState.tabs[id];
    if (!tab) continue;
    if (kind === "tunnel" && !tunnelAvailable) continue;
    if (rightDockTabRequiresProject(kind) && !projectPathKey) continue;
    nextTabs.push({ id, kind });
  }
  return nextTabs;
}

export function getCurrentRightDockActiveTab(
  activeTabId: string | undefined,
  visibleTabs: readonly RightDockVisibleTab[],
): RightDockTabKind {
  if (!activeTabId) return "terminal";
  return visibleTabs.find((tab) => tab.id === activeTabId)?.kind ?? "terminal";
}

export function getReorderedTabIdsFromPointer(
  container: HTMLElement | null,
  draggedId: string,
  clientX: number,
) {
  if (!container) return null;
  const tabElements = Array.from(
    container.querySelectorAll<HTMLElement>("[data-project-tools-tab-id]"),
  );
  const currentIds = tabElements
    .map((element) => element.dataset.projectToolsTabId ?? "")
    .filter(Boolean);
  if (!currentIds.includes(draggedId)) return null;

  const idsWithoutDragged = currentIds.filter((id) => id !== draggedId);
  let insertIndex = idsWithoutDragged.length;
  let visibleIndex = 0;
  for (const element of tabElements) {
    const id = element.dataset.projectToolsTabId ?? "";
    if (!id || id === draggedId) continue;
    const rect = element.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      insertIndex = visibleIndex;
      break;
    }
    visibleIndex += 1;
  }
  return [
    ...idsWithoutDragged.slice(0, insertIndex),
    draggedId,
    ...idsWithoutDragged.slice(insertIndex),
  ];
}

export function autoScrollTabsForPointer(container: HTMLElement | null, clientX: number) {
  if (!container) return;
  const maxScrollLeft = container.scrollWidth - container.clientWidth;
  if (maxScrollLeft <= 1) return;
  const rect = container.getBoundingClientRect();
  const edgeSize = 32;
  const scrollStep = 18;
  if (clientX < rect.left + edgeSize) {
    container.scrollLeft = Math.max(0, container.scrollLeft - scrollStep);
  } else if (clientX > rect.right - edgeSize) {
    container.scrollLeft = Math.min(maxScrollLeft, container.scrollLeft + scrollStep);
  }
}

export function reorderTabIdsByKeyboard(tabIds: readonly string[], tabId: string, key: string) {
  const currentIndex = tabIds.indexOf(tabId);
  if (currentIndex < 0) return null;

  let targetIndex = currentIndex;
  if (key === "ArrowLeft") {
    targetIndex = currentIndex - 1;
  } else if (key === "ArrowRight") {
    targetIndex = currentIndex + 1;
  } else if (key === "Home") {
    targetIndex = 0;
  } else if (key === "End") {
    targetIndex = tabIds.length - 1;
  } else {
    return null;
  }

  targetIndex = Math.max(0, Math.min(tabIds.length - 1, targetIndex));
  if (targetIndex === currentIndex) return null;

  const nextTabIds = [...tabIds];
  const [movedTabId] = nextTabIds.splice(currentIndex, 1);
  if (!movedTabId) return null;
  nextTabIds.splice(targetIndex, 0, movedTabId);
  return nextTabIds;
}

export function createRightDockSingletonTab(
  kind: Exclude<RightDockTabKind, "terminal">,
  projectPathKey: string,
): RightDockTabInstance {
  return {
    id: RIGHT_DOCK_SINGLETON_TAB_IDS[kind],
    kind,
    projectPathKey,
    createdAt: Date.now(),
  };
}

export function rightDockSingletonTabId(kind: Exclude<RightDockTabKind, "terminal">) {
  return RIGHT_DOCK_SINGLETON_TAB_IDS[kind];
}

export function createRightDockTerminalTab(
  session: TerminalSession,
  projectPathKey: string,
): RightDockTabInstance {
  return {
    id: session.id,
    kind: "terminal",
    projectPathKey,
    title: session.title,
    createdAt: session.createdAt,
    params: {
      sessionId: session.id,
    },
  };
}

export function sameRightDockOrder(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function removeRightDockTabFromState(
  state: RightDockProjectState,
  tabId: string,
): RightDockProjectState {
  if (!state.tabs[tabId]) return state;
  const tabs = { ...state.tabs };
  delete tabs[tabId];
  const tabOrder = state.tabOrder.filter((id) => id !== tabId && tabs[id]);
  const activeTabId =
    state.activeTabId === tabId ? tabOrder[0] : state.activeTabId && tabs[state.activeTabId]
      ? state.activeTabId
      : tabOrder[0];
  return {
    openVersion: state.openVersion,
    ...(activeTabId ? { activeTabId } : {}),
    tabOrder,
    tabs,
    stateVersion: state.stateVersion + 1,
  };
}
