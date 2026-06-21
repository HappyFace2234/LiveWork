import type { ToolResultMessage } from "@earendil-works/pi-ai";

import type { IconComponent } from "../../../../components/icons";
import {
  Bot,
  Brain,
  Eye,
  FilePenLine,
  FileText,
  FolderTree,
  ImageIcon,
  Plug,
  Search,
  Server,
  Terminal,
  Trash2,
  Wrench,
} from "../../../../components/icons";
import type { HostedSearchBlock } from "../../../../lib/chat/messages/hostedSearch";
import {
  safeStringify,
  shouldDisplayToolTraceItem,
  type ToolTraceItem,
  type UiRound,
} from "../../../../lib/chat/messages/uiMessages";
import type { DelegateAgentCardResultDetails } from "../../../../lib/tools/builtinTypes";

export function getToolMeta(name: string): {
  Icon: IconComponent;
  accent: string;
  category: string;
} {
  switch (name) {
    case "Bash":
    case "ManagedProcess":
      return { Icon: Terminal, accent: "var(--tool-bash-accent)", category: "terminal" };
    case "Read":
      return { Icon: Eye, accent: "var(--tool-file-accent)", category: "file" };
    case "Image":
      return { Icon: ImageIcon, accent: "var(--tool-file-accent)", category: "file" };
    case "SkillsManager":
      return { Icon: Eye, accent: "var(--tool-file-accent)", category: "file" };
    case "MemoryManager":
      return { Icon: Brain, accent: "var(--tool-list-accent)", category: "system" };
    case "McpManager":
      return { Icon: Plug, accent: "var(--tool-list-accent)", category: "mcp" };
    case "SSHManager":
    case "SshManager":
      return { Icon: Server, accent: "var(--tool-bash-accent)", category: "terminal" };
    case "Agent":
      return { Icon: Bot, accent: "var(--tool-list-accent)", category: "system" };
    case "SendMessage":
      return { Icon: Bot, accent: "var(--tool-list-accent)", category: "system" };
    case "Write":
      return { Icon: FileText, accent: "var(--tool-file-accent)", category: "file" };
    case "Edit":
      return { Icon: FilePenLine, accent: "var(--tool-file-accent)", category: "file" };
    case "Delete":
      return { Icon: Trash2, accent: "var(--tool-file-accent)", category: "file" };
    case "Glob":
      return { Icon: Search, accent: "var(--tool-search-accent)", category: "search" };
    case "Grep":
      return { Icon: Search, accent: "var(--tool-search-accent)", category: "search" };
    case "List":
      return { Icon: FolderTree, accent: "var(--tool-list-accent)", category: "list" };
    default:
      return { Icon: Wrench, accent: "var(--tool-file-accent)", category: "other" };
  }
}

export type MetaTag = { label: string; value: string };

export function displayString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function compactInlineText(value: unknown, maxChars = 120) {
  const text = displayString(value).replace(/\s+/g, " ");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

export function isDelegateAgentCardToolCall(toolCall: {
  name: string;
  arguments?: Record<string, unknown>;
}) {
  return toolCall.name === "Agent" && toolCall.arguments?.delegate_agent_card === true;
}

export function getDelegateAgentTask(agent: { prompt?: unknown; description?: unknown }) {
  return displayString(agent.prompt) || displayString(agent.description);
}

export function getDelegateAgentInlineSummary(item: ToolTraceItem) {
  const details = item.toolResult?.details as Partial<DelegateAgentCardResultDetails> | undefined;
  const agent = details?.kind === "delegate_agent_item" ? details.agent : undefined;
  const args = item.toolCall.arguments || {};
  const name =
    displayString(agent?.name) ||
    displayString(agent?.agentName) ||
    displayString(args.name) ||
    displayString(args.agent_id) ||
    displayString(args.id);
  const task = agent
    ? getDelegateAgentTask(agent)
    : displayString(args.prompt) || displayString(args.description);

  if (name && task) return `${name} - ${compactInlineText(task, 96)}`;
  return name || compactInlineText(task, 120);
}

export function shouldShowDelegateApplyStatus(agent: DelegateAgentCardResultDetails["agent"]) {
  if (!agent.applyStatus) return false;
  if (agent.applyStatus === "applied" || agent.applyStatus === "failed") return true;
  return Boolean(agent.applySkippedReason && agent.applySkippedReason !== "no_changes");
}

export function shouldShowDelegateCleanupStatus(agent: DelegateAgentCardResultDetails["agent"]) {
  return Boolean(
    agent.worktreeCleanupStatus &&
      agent.worktreeCleanupStatus !== "removed" &&
      agent.worktreeCleanupStatus !== "skipped",
  );
}

export function shouldShowDelegateWorktreeLocation(agent: DelegateAgentCardResultDetails["agent"]) {
  return Boolean(
    agent.worktreeRoot &&
      (agent.status === "failed" ||
        agent.worktreeCleanupStatus === "retained" ||
        agent.worktreeCleanupStatus === "failed"),
  );
}

export type GroupedRoundBlock =
  | {
      kind: "thinking";
      key: string;
      text: string;
    }
  | {
      kind: "text";
      key: string;
      text: string;
    }
  | {
      kind: "tool";
      key: string;
      item: ToolTraceItem;
    }
  | {
      kind: "hostedSearch";
      key: string;
      item: HostedSearchBlock;
    }
  | {
      kind: "hostedSearchGroup";
      key: string;
      items: HostedSearchBlock[];
    }
  | {
      kind: "toolGroup";
      key: string;
      items: ToolTraceItem[];
    };

export type ShellResultDetails = {
  exit_code: number;
  shell: string;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  timed_out: boolean;
  cancelled?: boolean;
  effective_timeout_ms?: number;
  duration_ms: number;
};

export function isShellResultDetails(value: unknown): value is ShellResultDetails {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.exit_code === "number" &&
    typeof candidate.shell === "string" &&
    typeof candidate.stdout === "string" &&
    typeof candidate.stderr === "string" &&
    typeof candidate.stdout_truncated === "boolean" &&
    typeof candidate.stderr_truncated === "boolean" &&
    typeof candidate.timed_out === "boolean" &&
    typeof candidate.duration_ms === "number"
  );
}

export function summarizeShellStream(text: string, truncated: boolean) {
  const length = text.length;
  if (length === 0) return "empty";
  return truncated ? `${length} chars, truncated` : `${length} chars`;
}

const stableValueSignatureCache = new WeakMap<object, string>();

export function getStableValueSignature(value: unknown) {
  if (value && typeof value === "object") {
    const cached = stableValueSignatureCache.get(value);
    if (cached !== undefined) {
      return cached;
    }
    const signature = safeStringify(value);
    stableValueSignatureCache.set(value, signature);
    return signature;
  }
  return safeStringify(value);
}

export function areStableValuesEqual(previous: unknown, next: unknown) {
  return previous === next || getStableValueSignature(previous) === getStableValueSignature(next);
}

export function getToolTraceKey(item: ToolTraceItem, index: number) {
  const id = item.toolCall.id?.trim();
  if (id) return id;
  return `${item.toolCall.name}-${index}-${getStableValueSignature(item.toolCall.arguments)}`;
}

export function isAgentToolName(name: string) {
  return name === "Agent";
}

export function getToolDisplayName(name: string) {
  if (name === "SshManager") return "SSHManager";
  return name;
}

export function groupRoundBlocks(blocks: UiRound["blocks"]): GroupedRoundBlock[] {
  const groupedBlocks: GroupedRoundBlock[] = [];
  let pendingTools: ToolTraceItem[] = [];
  let pendingStartIndex = 0;
  let pendingSearches: HostedSearchBlock[] = [];
  let pendingSearchStartIndex = 0;
  const hasHostedSearch = blocks.some((block) => block.kind === "hostedSearch");

  const flushPendingTools = () => {
    if (pendingTools.length === 0) return;
    if (pendingTools.length === 1) {
      const item = pendingTools[0];
      groupedBlocks.push({
        kind: "tool",
        key: `tool-${getToolTraceKey(item, pendingStartIndex)}`,
        item,
      });
    } else {
      groupedBlocks.push({
        kind: "toolGroup",
        key: `tool-group-${pendingStartIndex}-${pendingTools
          .map((item, index) => getToolTraceKey(item, pendingStartIndex + index))
          .join("|")}`,
        items: pendingTools,
      });
    }
    pendingTools = [];
  };

  const flushPendingSearches = () => {
    if (pendingSearches.length === 0) return;
    const firstSearch = pendingSearches[0];
    groupedBlocks.push({
      kind: "hostedSearchGroup",
      key: `hosted-search-group-${firstSearch?.id || pendingSearchStartIndex}`,
      items: pendingSearches,
    });
    pendingSearches = [];
  };

  blocks.forEach((block, index) => {
    if (block.kind === "tool") {
      if (!shouldDisplayToolTraceItem(block.item, { hasHostedSearch })) {
        return;
      }
      flushPendingSearches();
      if (block.item.toolCall.name === "Image" || isAgentToolName(block.item.toolCall.name)) {
        flushPendingTools();
        groupedBlocks.push({
          kind: "tool",
          key: `tool-${getToolTraceKey(block.item, index)}`,
          item: block.item,
        });
        return;
      }
      if (pendingTools.length === 0) {
        pendingStartIndex = index;
      }
      pendingTools.push(block.item);
      return;
    }

    flushPendingTools();
    if (block.kind === "hostedSearch") {
      if (pendingSearches.length === 0) {
        pendingSearchStartIndex = index;
      }
      pendingSearches.push(block.item);
      return;
    }
    flushPendingSearches();
    if (block.kind === "thinking") {
      groupedBlocks.push({ kind: "thinking", key: `thinking-${index}`, text: block.text });
      return;
    }
    groupedBlocks.push({ kind: "text", key: `text-${index}`, text: block.text });
  });

  flushPendingTools();
  flushPendingSearches();
  return groupedBlocks;
}

export function getToolGroupCounts(items: ToolTraceItem[], runningToolCallIds: string[]) {
  const runningIds = new Set(runningToolCallIds);
  let running = 0;
  let failed = 0;
  let completed = 0;
  let waiting = 0;

  for (const item of items) {
    if (item.toolCall.id && runningIds.has(item.toolCall.id)) {
      running += 1;
      continue;
    }
    if (!item.toolResult) {
      waiting += 1;
      continue;
    }
    if (item.toolResult.isError) {
      failed += 1;
      continue;
    }
    completed += 1;
  }

  return { running, failed, completed, waiting };
}

export function getToolGroupComposition(items: ToolTraceItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = getToolDisplayName(item.toolCall.name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ");
}

export function getDominantToolName(items: ToolTraceItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.toolCall.name, (counts.get(item.toolCall.name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Tool";
}

export function getBuiltinResultKind(result?: ToolResultMessage) {
  if (!result?.details || typeof result.details !== "object") return null;
  const kind = (result.details as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}
