import type { RefObject } from "react";
import { useLocale } from "../../i18n";
import type {
  RightDockFileTreeState,
  RightDockFileTreeStatePatch,
  RightDockTabKind,
  SshHostConfig,
} from "../../lib/settings";
import type { GitClient } from "../../lib/git/types";
import { cn } from "../../lib/shared/utils";
import type {
  TerminalClient,
  TerminalSession,
  TerminalSnapshot,
} from "../../lib/terminal/types";
import { Terminal } from "../icons";
import { Button } from "../ui/button";
import {
  GitReviewPanel,
  type GitCommitContextPayload,
  type GitFileContextPayload,
} from "./GitReviewPanel";
import { LocalTunnelPanel, type LocalTunnelClient } from "./LocalTunnelPanel";
import { ProjectFileTreePanel } from "./ProjectFileTreePanel";
import { SshTunnelPanel } from "./SshTunnelPanel";
import { XTermViewport } from "./XTermViewport";

type RightDockContentProps = {
  projectPathKey: string;
  cwd: string;
  currentActiveTab: RightDockTabKind;
  fileTreeInitialized: boolean;
  gitReviewInitialized: boolean;
  tunnelInitialized: boolean;
  sshTunnelInitialized: boolean;
  fileTreeState: RightDockFileTreeState;
  gitClient?: GitClient | null;
  gitWriteEnabled: boolean;
  gitDisabledMessage?: string;
  tunnelClient?: LocalTunnelClient | null;
  tunnelEnabled: boolean;
  tunnelDisabledMessage?: string;
  tunnelRefreshToken?: number;
  sshHosts: SshHostConfig[];
  associatedSshHostIds: string[];
  client: TerminalClient;
  sshSessions: TerminalSession[];
  localSessions: TerminalSession[];
  activeSession: TerminalSession | null;
  initialTerminalSnapshotsRef: RefObject<Map<string, TerminalSnapshot>>;
  theme: "light" | "dark";
  error: string | null;
  terminalReady: boolean;
  terminalDisabledMessage?: string;
  creating: boolean;
  loading: boolean;
  onFileTreeInitializedChange: (initialized: boolean) => void;
  onFileTreeStateChange: (patch: RightDockFileTreeStatePatch) => void;
  onInsertFileMention?: (path: string, kind: "file" | "dir") => void;
  onOpenFile?: (path: string) => void;
  onRevealInFileTree: (path: string) => void;
  onInsertCommitMention?: (commit: GitCommitContextPayload) => void;
  onInsertGitFileMention?: (file: GitFileContextPayload) => void;
  onSessionSnapshot: (snapshot: TerminalSnapshot) => void;
  onSessionClosed: (sessionId: string) => void;
  onSshSessionsReconcile: (sessions: TerminalSession[]) => void;
  onOpenSshSession?: (session: TerminalSession, kind?: "bash" | "sftp") => void;
  onSshProjectHostIdsChange?: (hostIds: string[]) => void;
  onTerminalError: (error: string | null) => void;
  onInitialTerminalSnapshotConsumed: (sessionId: string) => void;
  onCreateTerminal: () => void;
};

export function RightDockContent(props: RightDockContentProps) {
  const {
    projectPathKey,
    cwd,
    currentActiveTab,
    fileTreeInitialized,
    gitReviewInitialized,
    tunnelInitialized,
    sshTunnelInitialized,
    fileTreeState,
    gitClient,
    gitWriteEnabled,
    gitDisabledMessage,
    tunnelClient,
    tunnelEnabled,
    tunnelDisabledMessage,
    tunnelRefreshToken,
    sshHosts,
    associatedSshHostIds,
    client,
    sshSessions,
    localSessions,
    activeSession,
    initialTerminalSnapshotsRef,
    theme,
    error,
    terminalReady,
    terminalDisabledMessage,
    creating,
    loading,
    onFileTreeInitializedChange,
    onFileTreeStateChange,
    onInsertFileMention,
    onOpenFile,
    onRevealInFileTree,
    onInsertCommitMention,
    onInsertGitFileMention,
    onSessionSnapshot,
    onSessionClosed,
    onSshSessionsReconcile,
    onOpenSshSession,
    onSshProjectHostIdsChange,
    onTerminalError,
    onInitialTerminalSnapshotConsumed,
    onCreateTerminal,
  } = props;
  const { t } = useLocale();

  return (
    <>
      {fileTreeInitialized ? (
        <div
          className={cn(
            "min-h-0 flex-1",
            currentActiveTab === "fileTree" ? "block" : "hidden",
          )}
        >
          <ProjectFileTreePanel
            key={projectPathKey}
            projectPathKey={projectPathKey}
            cwd={cwd}
            initialized={fileTreeInitialized}
            syncState={fileTreeState}
            onInitializedChange={onFileTreeInitializedChange}
            onSyncStateChange={onFileTreeStateChange}
            onInsertFileMention={onInsertFileMention}
            onOpenFile={onOpenFile}
          />
        </div>
      ) : null}
      {gitReviewInitialized ? (
        <div
          className={cn(
            "min-h-0 flex-1",
            currentActiveTab === "gitReview" ? "flex flex-col" : "hidden",
          )}
        >
          <GitReviewPanel
            key={`${projectPathKey}:git-review`}
            cwd={cwd}
            gitClient={gitClient}
            canWrite={gitWriteEnabled}
            disabledMessage={gitDisabledMessage}
            onRevealInFileTree={onRevealInFileTree}
            onInsertCommitMention={onInsertCommitMention}
            onInsertGitFileMention={onInsertGitFileMention}
          />
        </div>
      ) : null}
      {tunnelInitialized && tunnelClient ? (
        <div
          className={cn(
            "min-h-0 flex-1",
            currentActiveTab === "tunnel" ? "flex flex-col" : "hidden",
          )}
        >
          <LocalTunnelPanel
            client={tunnelClient}
            enabled={tunnelEnabled}
            disabledMessage={tunnelDisabledMessage}
            projectPathKey={projectPathKey}
            refreshToken={tunnelRefreshToken}
          />
        </div>
      ) : null}
      {sshTunnelInitialized ? (
        <div
          className={cn(
            "min-h-0 flex-1",
            currentActiveTab === "sshTunnel" ? "flex flex-col" : "hidden",
          )}
        >
          <SshTunnelPanel
            active={currentActiveTab === "sshTunnel"}
            cwd={cwd}
            projectPathKey={projectPathKey}
            hosts={sshHosts}
            associatedHostIds={associatedSshHostIds}
            client={client}
            sessions={sshSessions}
            onSessionSnapshot={onSessionSnapshot}
            onSessionClosed={onSessionClosed}
            onSshSessionsReconcile={onSshSessionsReconcile}
            onOpenSession={(session, kind) => onOpenSshSession?.(session, kind)}
            onAssociatedHostIdsChange={(hostIds) => {
              onSshProjectHostIdsChange?.(hostIds);
            }}
          />
        </div>
      ) : null}
      {localSessions.length > 0 ? (
        <div
          className={cn(
            "min-h-0 flex-1 flex-col",
            currentActiveTab === "terminal" ? "flex" : "hidden",
          )}
        >
          {error ? (
            <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
          <div className="relative min-h-0 flex-1">
            {localSessions.map((session) => {
              const isActiveTerminal =
                currentActiveTab === "terminal" && activeSession?.id === session.id;
              return (
                <div
                  key={session.id}
                  aria-hidden={!isActiveTerminal}
                  className={cn(
                    "absolute inset-0 min-h-0",
                    isActiveTerminal ? "block" : "hidden",
                  )}
                >
                  <XTermViewport
                    client={client}
                    session={session}
                    theme={theme}
                    isActive={isActiveTerminal}
                    initialSnapshot={
                      initialTerminalSnapshotsRef.current.get(session.id) ?? undefined
                    }
                    onError={onTerminalError}
                    onInitialSnapshotConsumed={onInitialTerminalSnapshotConsumed}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : currentActiveTab === "terminal" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted/80">
            <Terminal className="h-6 w-6 text-muted-foreground" />
          </div>
          <div className="flex flex-col gap-1">
            <div className="text-sm font-medium text-foreground">
              {t("projectTools.newTerminal")}
            </div>
            {error ? (
              <div className="text-xs text-destructive">{error}</div>
            ) : terminalDisabledMessage ? (
              <div className="max-w-xs text-xs text-muted-foreground">
                {terminalDisabledMessage}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                {t("projectTools.terminalDescription")}
              </div>
            )}
          </div>
          <Button onClick={onCreateTerminal} disabled={!terminalReady || creating} size="sm">
            {t("projectTools.newTerminal")}
          </Button>
          {loading ? (
            <div className="text-xs text-muted-foreground">{t("projectTools.loading")}</div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
