import { useCallback, useState } from "react";
import { useLocale } from "../../i18n";
import {
  type RightDockFileTreeState,
  type RightDockFileTreeStatePatch,
  type RightDockProjectState,
  type SshHostConfig,
} from "../../lib/settings";
import type { GitClient } from "../../lib/git/types";
import { cn } from "../../lib/shared/utils";
import type {
  TerminalClient,
  TerminalSession,
} from "../../lib/terminal/types";
import { X } from "../icons";
import { Button } from "../ui/button";
import type { GitCommitContextPayload, GitFileContextPayload } from "./GitReviewPanel";
import type { LocalTunnelClient } from "./LocalTunnelPanel";
import { RightDockContent } from "./RightDockContent";
import {
  dirname,
  expandedPathsForFileTreePath,
  formatTerminalSessionTitle,
  rightDockTabRequiresProject,
  type RightDockSingletonTabKind,
} from "./rightDockModel";
import { RightDockChooser, RightDockCreateMenu } from "./RightDockLauncher";
import { RightDockTabStrip } from "./RightDockTabStrip";
import { useRightDockPanelWidth } from "./useRightDockPanelWidth";
import { useRightDockProjectTabs } from "./useRightDockProjectTabs";
import { useRightDockSessions } from "./useRightDockSessions";
import { useRightDockTabReorder } from "./useRightDockTabReorder";

type RightDockPanelProps = {
  isOpen: boolean;
  collapseImmediately?: boolean;
  projectPathKey: string;
  cwd: string;
  sessions?: TerminalSession[];
  width: number;
  theme: "light" | "dark";
  disabledMessage?: string;
  terminalDisabledMessage?: string;
  projectState: RightDockProjectState;
  fileTreeState: RightDockFileTreeState;
  sshHosts?: SshHostConfig[];
  associatedSshHostIds?: string[];
  client: TerminalClient;
  gitClient?: GitClient | null;
  gitWriteEnabled?: boolean;
  gitDisabledMessage?: string;
  tunnelClient?: LocalTunnelClient | null;
  tunnelEnabled?: boolean;
  tunnelDisabledMessage?: string;
  tunnelRefreshToken?: number;
  onWidthChange: (width: number) => void;
  onProjectStateChange: (
    updater: (current: RightDockProjectState) => RightDockProjectState,
  ) => void;
  onFileTreeStateChange: (patch: RightDockFileTreeStatePatch) => void;
  onSshProjectHostIdsChange?: (hostIds: string[]) => void;
  onOpenSshSession?: (session: TerminalSession, kind?: "bash" | "sftp") => void;
  onSessionsChange?: (sessions: TerminalSession[]) => void;
  onInsertFileMention?: (path: string, kind: "file" | "dir") => void;
  onOpenFile?: (path: string) => void;
  onInsertCommitMention?: (commit: GitCommitContextPayload) => void;
  onInsertGitFileMention?: (file: GitFileContextPayload) => void;
  onClose?: () => void;
};

export function RightDockPanel(props: RightDockPanelProps) {
  const {
    isOpen,
    collapseImmediately = false,
    projectPathKey,
    cwd,
    sessions: externalSessions,
    width,
    theme,
    disabledMessage,
    terminalDisabledMessage,
    projectState,
    fileTreeState,
    sshHosts = [],
    associatedSshHostIds = [],
    client,
    gitClient,
    gitWriteEnabled = true,
    gitDisabledMessage,
    tunnelClient,
    tunnelEnabled = true,
    tunnelDisabledMessage,
    tunnelRefreshToken,
    onWidthChange,
    onProjectStateChange,
    onFileTreeStateChange,
    onSshProjectHostIdsChange,
    onOpenSshSession,
    onSessionsChange,
    onInsertFileMention,
    onOpenFile,
    onInsertCommitMention,
    onInsertGitFileMention,
    onClose,
  } = props;
  const { t } = useLocale();
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const {
    effectiveShouldRenderContent,
    effectiveWidthCollapsed,
    handleResizeStart,
    isResizing,
    panelRef,
    panelStyle,
  } = useRightDockPanelWidth({
    collapseImmediately,
    isOpen,
    onWidthChange,
    width,
  });
  const projectReady = projectPathKey.trim() !== "" && cwd.trim() !== "" && !disabledMessage;
  const terminalReady = projectReady && !terminalDisabledMessage;
  const {
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
    rememberTerminalSnapshot,
    setError,
    shellOptions,
    sshSessions,
  } = useRightDockSessions({
    client,
    cwd,
    externalSessions,
    isOpen,
    onProjectStateChange,
    onSessionsChange,
    projectPathKey,
    projectState,
    terminalReady,
  });
  const tunnelAvailable = Boolean(tunnelClient);
  const {
    activateTab,
    canReorderTabs,
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
  } = useRightDockProjectTabs({
    localSessions,
    onProjectStateChange,
    projectPathKey,
    projectState,
    tunnelAvailable,
  });

  const handleCreate = useCallback(() => {
    createTerminal();
  }, [createTerminal]);

  const {
    consumeSuppressedTabClick,
    draggingTabId,
    renderTabDragHandle,
    tabsScrollRef,
  } = useRightDockTabReorder({
    canReorderTabs,
    onCommitTabOrder: commitTabOrder,
    onDraftTabOrderChange: setDraftTabOrder,
    orderedTabIds: orderedProjectTabIds,
    projectPathKey,
    reorderHint: t("projectTools.reorderTabHint"),
    reorderLabel: t("projectTools.reorderTab"),
  });

  const showDisabledMessage = Boolean(
    disabledMessage && !tunnelAvailable && !tunnelInitialized && !sshTunnelInitialized,
  );
  const showRightDockChooser =
    !showDisabledMessage &&
    (projectReady || tunnelAvailable) &&
    currentActiveTab === "terminal" &&
    !activeSession;

  const startToolTab = useCallback(
    (kind: RightDockSingletonTabKind) => {
      if (rightDockTabRequiresProject(kind)) {
        if (!projectReady) return;
      } else if (!tunnelClient) {
        return;
      }
      openSingletonTab(kind);
    },
    [openSingletonTab, projectReady, tunnelClient],
  );

  const setFileTreeInitialized = useCallback(
    (initialized: boolean) => {
      if (!projectPathKey) return;
      if (initialized) {
        startToolTab("fileTree");
      } else {
        closeToolTab("fileTree");
      }
    },
    [closeToolTab, projectPathKey, startToolTab],
  );

  const revealPathInFileTree = useCallback(
    (path: string) => {
      const normalizedPath = path
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "");
      if (!projectReady) return;
      const selectedPath = normalizedPath.endsWith("/") ? dirname(normalizedPath) : normalizedPath;
      const expandedPaths = Array.from(
        new Set([...fileTreeState.expandedPaths, ...expandedPathsForFileTreePath(selectedPath)]),
      );
      startToolTab("fileTree");
      onFileTreeStateChange({
        query: "",
        selectedPath,
        expandedPaths,
        bumpRevision: true,
        bumpStateVersion: true,
      });
    },
    [
      fileTreeState.expandedPaths,
      onFileTreeStateChange,
      projectReady,
      startToolTab,
    ],
  );

  return (
    <aside
      ref={panelRef}
      aria-hidden={!isOpen}
      inert={!isOpen}
      data-state={isOpen ? "open" : "closed"}
      data-project-tools-resizing={isResizing ? "true" : undefined}
      className={cn(
        "project-tools-panel fixed inset-x-0 bottom-0 z-40 flex h-[min(72vh,34rem)] min-h-0 w-full shrink-0 flex-col overflow-hidden bg-background shadow-2xl transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none md:relative md:inset-auto md:z-10 md:h-full md:overflow-visible md:shadow-none",
        isOpen
          ? "pointer-events-auto translate-y-0 border-t border-border opacity-100 md:w-[var(--project-tools-panel-width)] md:translate-x-0 md:border-l md:border-t-0"
          : "pointer-events-none translate-y-full border-t border-transparent opacity-0 md:translate-x-3 md:translate-y-0 md:border-l-0 md:border-t-0",
        effectiveWidthCollapsed ? "md:w-0" : "md:w-[var(--project-tools-panel-width)]",
      )}
      style={panelStyle}
    >
      <div
        className={cn(
          "project-tools-panel-inner flex h-full min-h-0 w-full flex-col transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none md:w-[var(--project-tools-panel-width)] md:min-w-[var(--project-tools-panel-width)]",
          isOpen
            ? "translate-y-0 opacity-100 md:translate-x-0"
            : "translate-y-3 opacity-0 md:translate-x-2 md:translate-y-0",
        )}
      >
        {effectiveShouldRenderContent ? (
          <>
            <div className="project-tools-panel-handle" aria-hidden="true" />
            <button
              type="button"
              aria-label={t("projectTools.resizePanel")}
              title={t("projectTools.resizePanel")}
              className={cn(
                "group absolute inset-y-0 left-0 z-[90] hidden w-3 cursor-col-resize touch-none items-center justify-center border-0 bg-transparent p-0 md:flex",
                "focus-visible:outline-none",
              )}
              onMouseDown={handleResizeStart}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-10 w-0.5 rounded-full bg-muted-foreground/25 opacity-70 shadow-sm transition-[height,background-color,opacity]",
                  "group-hover:h-16 group-hover:bg-primary/60 group-hover:opacity-100 group-focus-visible:h-16 group-focus-visible:bg-primary group-focus-visible:opacity-100",
                  isResizing && "h-20 bg-primary opacity-100",
                )}
              />
            </button>
            <div className="project-tools-panel-header flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
              <div className="project-tools-panel-tabs-shell min-w-0 flex-1">
                <div
                  ref={tabsScrollRef}
                  className="project-tools-panel-tabs flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden"
                >
                  <RightDockTabStrip
                    tabs={orderedProjectTabs}
                    currentActiveTab={currentActiveTab}
                    activeSession={activeSession}
                    pendingCloseSessionId={pendingCloseSessionId}
                    closingSessionId={closingSessionId}
                    draggingTabId={draggingTabId}
                    renderTabDragHandle={renderTabDragHandle}
                    consumeSuppressedTabClick={consumeSuppressedTabClick}
                    onActivateTab={activateTab}
                    onActivateTerminalSession={activateTerminalSession}
                    onCloseToolTab={closeToolTab}
                    onCloseTerminalRequest={handleCloseRequest}
                  />
                </div>
              </div>
              <RightDockCreateMenu
                open={createMenuOpen}
                onOpenChange={setCreateMenuOpen}
                shellOptions={shellOptions}
                terminalReady={terminalReady}
                terminalDisabledMessage={terminalDisabledMessage}
                projectReady={projectReady}
                tunnelAvailable={tunnelAvailable}
                creating={creating}
                onCreateTerminal={createTerminal}
                onStartTool={startToolTab}
              />
              {onClose ? (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onClose}
                  title={t("projectTools.closePanel")}
                  className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground md:hidden"
                >
                  <X className="h-4 w-4" />
                </Button>
              ) : null}
            </div>

            {pendingCloseSession ? (
              <div className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <span className="min-w-0 flex-1 truncate">
                  {t("projectTools.closeRunningTerminal").replace(
                    "{title}",
                    formatTerminalSessionTitle(
                      pendingCloseSession.title,
                      t("projectTools.terminalTitle"),
                    ),
                  )}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2.5 text-xs"
                  onClick={clearPendingCloseSession}
                >
                  {t("settings.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="h-7 shrink-0 px-2.5 text-xs"
                  disabled={closingSessionId === pendingCloseSession.id}
                  onClick={() => closeSession(pendingCloseSession)}
                >
                  {t("projectTools.close")}
                </Button>
              </div>
            ) : null}

            {showDisabledMessage ? (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {disabledMessage}
              </div>
            ) : showRightDockChooser ? (
              <RightDockChooser
                terminalReady={terminalReady}
                terminalDisabledMessage={terminalDisabledMessage}
                disabledMessage={disabledMessage}
                projectReady={projectReady}
                tunnelAvailable={tunnelAvailable}
                creating={creating}
                loading={loading}
                error={error}
                onCreateTerminal={createTerminal}
                onStartTool={startToolTab}
              />
            ) : (
              <RightDockContent
                projectPathKey={projectPathKey}
                cwd={cwd}
                currentActiveTab={currentActiveTab}
                fileTreeInitialized={fileTreeInitialized}
                gitReviewInitialized={gitReviewInitialized}
                tunnelInitialized={tunnelInitialized}
                sshTunnelInitialized={sshTunnelInitialized}
                fileTreeState={fileTreeState}
                gitClient={gitClient}
                gitWriteEnabled={gitWriteEnabled}
                gitDisabledMessage={gitDisabledMessage}
                tunnelClient={tunnelClient}
                tunnelEnabled={tunnelEnabled}
                tunnelDisabledMessage={tunnelDisabledMessage}
                tunnelRefreshToken={tunnelRefreshToken}
                sshHosts={sshHosts}
                associatedSshHostIds={associatedSshHostIds}
                client={client}
                sshSessions={sshSessions}
                localSessions={localSessions}
                activeSession={activeSession}
                initialTerminalSnapshotsRef={initialTerminalSnapshotsRef}
                theme={theme}
                error={error}
                terminalReady={terminalReady}
                terminalDisabledMessage={terminalDisabledMessage}
                creating={creating}
                loading={loading}
                onFileTreeInitializedChange={setFileTreeInitialized}
                onFileTreeStateChange={onFileTreeStateChange}
                onInsertFileMention={onInsertFileMention}
                onOpenFile={onOpenFile}
                onRevealInFileTree={revealPathInFileTree}
                onInsertCommitMention={onInsertCommitMention}
                onInsertGitFileMention={onInsertGitFileMention}
                onSessionSnapshot={rememberTerminalSnapshot}
                onSessionClosed={forgetTerminalSession}
                onOpenSshSession={onOpenSshSession}
                onSshProjectHostIdsChange={onSshProjectHostIdsChange}
                onTerminalError={setError}
                onInitialTerminalSnapshotConsumed={handleInitialTerminalSnapshotConsumed}
                onCreateTerminal={handleCreate}
              />
            )}
          </>
        ) : null}
      </div>
    </aside>
  );
}
