import { useCallback, useEffect, useMemo, useState } from "react";
import type { RightDockProjectState } from "@/lib/settings";
import type { TerminalSession } from "@/lib/terminal/types";
import {
  createRightDockSingletonTab,
  FILE_TREE_TAB_ID,
  getCurrentRightDockActiveTab,
  getRightDockVisibleTabs,
  GIT_REVIEW_TAB_ID,
  orderRightDockVisibleTabs,
  removeRightDockTabFromState,
  rightDockSingletonTabId,
  sameRightDockOrder,
  SSH_TUNNEL_TAB_ID,
  tabOrderIdsEqual,
  TUNNEL_TAB_ID,
  type RightDockSingletonTabKind,
} from "./rightDockModel";

type UseRightDockProjectTabsOptions = {
  localSessions: TerminalSession[];
  projectPathKey: string;
  projectState: RightDockProjectState;
  tunnelAvailable: boolean;
  onProjectStateChange: (
    updater: (current: RightDockProjectState) => RightDockProjectState,
  ) => void;
};

export function useRightDockProjectTabs(options: UseRightDockProjectTabsOptions) {
  const {
    localSessions,
    onProjectStateChange,
    projectPathKey,
    projectState,
    tunnelAvailable,
  } = options;
  const [draftTabOrder, setDraftTabOrder] = useState<string[] | null>(null);
  const fileTreeInitialized = Boolean(projectPathKey && projectState.tabs[FILE_TREE_TAB_ID]);
  const gitReviewInitialized = Boolean(projectPathKey && projectState.tabs[GIT_REVIEW_TAB_ID]);
  const tunnelInitialized = Boolean(projectState.tabs[TUNNEL_TAB_ID] && tunnelAvailable);
  const sshTunnelInitialized = Boolean(projectPathKey && projectState.tabs[SSH_TUNNEL_TAB_ID]);
  const visibleTabs = useMemo(
    () =>
      getRightDockVisibleTabs({
        localSessions,
        projectPathKey,
        projectState,
        tunnelAvailable,
      }),
    [localSessions, projectPathKey, projectState, tunnelAvailable],
  );
  const effectiveTabOrder = draftTabOrder ?? projectState.tabOrder;
  const orderedProjectTabs = useMemo(
    () => orderRightDockVisibleTabs(visibleTabs, effectiveTabOrder),
    [effectiveTabOrder, visibleTabs],
  );
  const orderedProjectTabIds = useMemo(
    () => orderedProjectTabs.map((tab) => tab.id),
    [orderedProjectTabs],
  );
  const currentActiveTab = getCurrentRightDockActiveTab(projectState.activeTabId, visibleTabs);

  useEffect(() => {
    if (!draftTabOrder) return;
    if (tabOrderIdsEqual(draftTabOrder, projectState.tabOrder)) {
      setDraftTabOrder(null);
    }
  }, [draftTabOrder, projectState.tabOrder]);

  const activateTab = useCallback(
    (tabId: string) => {
      if (!tabId) return;
      onProjectStateChange((current) =>
        current.activeTabId === tabId
          ? current
          : {
              ...current,
              activeTabId: tabId,
              tabOrder: current.tabOrder.includes(tabId)
                ? current.tabOrder
                : [...current.tabOrder, tabId],
              stateVersion: current.stateVersion + 1,
            },
      );
    },
    [onProjectStateChange],
  );

  const openSingletonTab = useCallback(
    (kind: RightDockSingletonTabKind) => {
      const tabId = rightDockSingletonTabId(kind);
      onProjectStateChange((current) => {
        const tab = current.tabs[tabId] ?? createRightDockSingletonTab(kind, projectPathKey);
        const tabs = current.tabs[tabId] ? current.tabs : { ...current.tabs, [tabId]: tab };
        const tabOrder = current.tabOrder.includes(tabId)
          ? current.tabOrder
          : [...current.tabOrder, tabId];
        if (
          current.activeTabId === tabId &&
          tabs === current.tabs &&
          tabOrder === current.tabOrder
        ) {
          return current;
        }
        return {
          ...current,
          activeTabId: tabId,
          tabOrder,
          tabs,
          openVersion: current.openVersion + (current.tabs[tabId] ? 0 : 1),
          stateVersion: current.stateVersion + 1,
        };
      });
    },
    [onProjectStateChange, projectPathKey],
  );

  const closeToolTab = useCallback(
    (kind: RightDockSingletonTabKind) => {
      const tabId = rightDockSingletonTabId(kind);
      onProjectStateChange((current) => removeRightDockTabFromState(current, tabId));
    },
    [onProjectStateChange],
  );

  const commitTabOrder = useCallback(
    (nextOrder: string[]) => {
      onProjectStateChange((current) => {
        const knownIds = new Set(Object.keys(current.tabs));
        const ordered: string[] = [];
        for (const id of nextOrder) {
          if (knownIds.has(id) && !ordered.includes(id)) ordered.push(id);
        }
        for (const id of current.tabOrder) {
          if (knownIds.has(id) && !ordered.includes(id)) ordered.push(id);
        }
        for (const id of Object.keys(current.tabs)) {
          if (!ordered.includes(id)) ordered.push(id);
        }
        if (sameRightDockOrder(current.tabOrder, ordered)) return current;
        return {
          ...current,
          tabOrder: ordered,
          stateVersion: current.stateVersion + 1,
        };
      });
    },
    [onProjectStateChange],
  );

  return {
    activateTab,
    canReorderTabs: orderedProjectTabIds.length > 1,
    closeToolTab,
    commitTabOrder,
    currentActiveTab,
    fileTreeInitialized,
    gitReviewInitialized,
    openSingletonTab,
    orderedProjectTabIds,
    orderedProjectTabs,
    setDraftTabOrder,
    sshTunnelInitialized,
    tunnelInitialized,
  };
}
