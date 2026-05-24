import { memo, useState, type MutableRefObject } from "react";
import { Loader2, Paperclip, Send, Square, X } from "../../components/icons";

import {
  MentionComposer,
  type MentionComposerHandle,
  type MentionComposerSkill,
} from "../../components/chat/MentionComposer";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import {
  formatUploadedFileSize,
  type PendingUploadedFile,
} from "../../lib/chat/messages/uploadedFiles";
import { cn } from "../../lib/shared/utils";

export const ChatComposerBar = memo(function ChatComposerBar(props: {
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  isSending: boolean;
  isUploadingFiles: boolean;
  isInputDisabled: boolean;
  inputPlaceholder: string;
  workdir: string;
  enabledSkills: MentionComposerSkill[];
  isAgentMode: boolean;
  onSend: () => void;
  onStop: () => void;
  onComposerBusyChange: (isBusy: boolean) => void;
  onPickReadableFiles: () => void;
  onPasteFiles: (files: File[]) => void;
  pendingUploadedFiles: PendingUploadedFile[];
  onRemovePendingUpload: (relativePath: string) => void;
}) {
  const {
    composerRef,
    isSending,
    isUploadingFiles,
    isInputDisabled,
    inputPlaceholder,
    workdir,
    enabledSkills,
    isAgentMode,
    onSend,
    onStop,
    onComposerBusyChange,
    onPickReadableFiles,
    onPasteFiles,
    pendingUploadedFiles,
    onRemovePendingUpload,
  } = props;
  const { t } = useLocale();
  const [composerIsEmpty, setComposerIsEmpty] = useState(true);
  const uploadDisabled = isInputDisabled || isSending || isUploadingFiles || !isAgentMode || !workdir;
  const sendDisabled =
    isInputDisabled ||
    isUploadingFiles ||
    (!isSending && composerIsEmpty && pendingUploadedFiles.length === 0);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4">
      <div className="pointer-events-auto relative w-full max-w-[768px]">
        {/* Pending uploaded files — above the composer card */}
        {pendingUploadedFiles.length > 0 && (
          <div className="upload-file-list mb-2.5 flex gap-2 overflow-x-auto px-0.5 pb-1">
            {pendingUploadedFiles.map((file) => (
              <div
                key={file.relativePath}
                title={file.relativePath}
                className="group flex w-[calc(25%-6px)] min-w-[calc(25%-6px)] items-center gap-2 rounded-xl border border-white/45 bg-white/55 px-2.5 py-1.5 text-[11px] shadow-[0_2px_8px_-2px_rgba(15,23,42,0.06)] backdrop-blur-2xl backdrop-saturate-150 transition-all hover:bg-white/75 hover:shadow-[0_4px_14px_-4px_rgba(15,23,42,0.10)] dark:border-white/10 dark:bg-white/[0.06] dark:hover:bg-white/[0.10]"
              >
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-sky-500/12 dark:bg-sky-400/15">
                  <Paperclip className="h-3 w-3 text-sky-600 dark:text-sky-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium tracking-tight text-foreground/90">
                    {file.fileName}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {formatUploadedFileSize(file.sizeBytes)}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={isInputDisabled || isSending}
                  onClick={() => onRemovePendingUpload(file.relativePath)}
                  className="shrink-0 rounded-full p-1 text-muted-foreground/70 opacity-0 transition-all hover:bg-foreground/5 hover:text-foreground group-hover:opacity-100 disabled:pointer-events-none"
                  aria-label={`${t("chat.upload.removeFile")} ${file.fileName}`}
                  title={t("chat.upload.removeFile")}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="composer-glass-card relative overflow-hidden rounded-[24px] border border-white/55 bg-white/65 shadow-[0_12px_40px_-12px_rgba(15,23,42,0.20),0_2px_6px_-2px_rgba(15,23,42,0.06)] backdrop-blur-xl backdrop-saturate-[180%] transition-all focus-within:border-white/80 focus-within:bg-white/72 focus-within:shadow-[0_18px_48px_-12px_rgba(15,23,42,0.26),0_4px_12px_-4px_rgba(15,23,42,0.08)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:focus-within:border-white/[0.14] dark:focus-within:bg-white/[0.075]">
          {/* macOS material rim-light */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-5 top-0 h-px rounded-full bg-gradient-to-r from-transparent via-white/85 to-transparent dark:via-white/15"
          />
          {/* subtle inner gloss gradient */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[24px] bg-gradient-to-b from-white/30 to-transparent opacity-60 dark:from-white/[0.04] dark:opacity-100"
          />

          <div className="relative px-4 pt-3.5">
            <MentionComposer
              ref={composerRef}
              onSend={onSend}
              onEmptyChange={setComposerIsEmpty}
              onBusyChange={onComposerBusyChange}
              onPasteFiles={onPasteFiles}
              placeholder={inputPlaceholder}
              disabled={isInputDisabled}
              workdir={workdir}
              enabledSkills={enabledSkills}
              className="px-0 py-0"
            />
          </div>

          <div className="relative flex items-center justify-between gap-2 px-3 pb-2 pt-1">
            <button
              type="button"
              disabled={uploadDisabled}
              onClick={onPickReadableFiles}
              title={
                isUploadingFiles
                  ? t("chat.upload.uploading")
                  : !isAgentMode
                  ? t("chat.upload.onlyInTools")
                  : !workdir
                    ? t("chat.upload.requireWorkdir")
                    : t("chat.upload.selectFiles")
              }
              aria-label={
                isUploadingFiles
                  ? t("chat.upload.uploading")
                  : !isAgentMode
                  ? t("chat.upload.onlyInTools")
                  : !workdir
                    ? t("chat.upload.requireWorkdir")
                    : t("chat.upload.selectFiles")
              }
              className={cn(
                "composer-toolbar-action relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-hidden transition-all",
                "disabled:pointer-events-none disabled:opacity-40",
                pendingUploadedFiles.length > 0
                  ? "bg-sky-500/14 text-sky-600 hover:bg-sky-500/20 active:bg-sky-500/24 dark:bg-sky-400/15 dark:text-sky-300 dark:hover:bg-sky-400/22"
                  : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.10] dark:hover:bg-white/[0.08] dark:active:bg-white/[0.12]",
              )}
            >
              {isUploadingFiles ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Paperclip className="h-4 w-4" />
              )}
              {pendingUploadedFiles.length > 0 ? (
                <span
                  aria-hidden
                  className="absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-sky-500 px-[3px] text-[9px] font-semibold leading-none text-white shadow-[0_0_0_1.5px_rgba(255,255,255,0.95)] dark:bg-sky-400 dark:text-slate-900 dark:shadow-[0_0_0_1.5px_rgba(20,22,28,0.9)]"
                >
                  {pendingUploadedFiles.length}
                </span>
              ) : null}
            </button>

            <Button
              disabled={sendDisabled}
              onClick={() => {
                if (isInputDisabled) return;
                if (isSending) {
                  onStop();
                  return;
                }
                onSend();
              }}
              size="icon"
              title={isSending ? t("chat.stopGeneration") : t("chat.sendMessage")}
              aria-label={isSending ? t("chat.stopGeneration") : t("chat.sendMessage")}
              style={
                isSending
                  ? {
                      backgroundColor: "hsl(var(--destructive))",
                      backgroundImage: "none",
                      color: "hsl(var(--destructive-foreground))",
                    }
                  : undefined
              }
              className="h-8 w-8 shrink-0 rounded-full shadow-[0_1px_2px_rgba(15,23,42,0.12)] transition-all disabled:opacity-100 [&:not(:disabled)]:bg-foreground [&:not(:disabled)]:text-background [&:not(:disabled)]:hover:bg-foreground/85 [&:not(:disabled)]:hover:shadow-[0_4px_14px_-2px_rgba(15,23,42,0.28)] [&:not(:disabled)]:active:scale-95 disabled:bg-foreground/10 disabled:text-foreground/35"
            >
              {isSending ? (
                <Square className="h-3 w-3 fill-current" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});
