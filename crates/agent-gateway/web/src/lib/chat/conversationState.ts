import type { AssistantMessage, Context, Message } from "../agentTypes";

import { assistantMessageToText } from "../providers/llm";
import { normalizeConversationSystemPrompt } from "./systemPrompt";
import {
  sanitizeMessagesForContinuation,
  sanitizeMessagesForModelContext,
} from "./requestContextSanitizer";
import { buildUiMessages, type UiRound } from "./uiMessages";
import {
  stripUploadedFilesMessageMetadata,
  type PendingUploadedFile,
} from "./uploadedFiles";

const INTERNAL_RESUME_MESSAGE_TEXT =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";

export type StoredSummaryMessage = {
  role: "summary";
  id: string;
  timestamp: number;
  content: string;
  summaryMeta: {
    format: "plain-text-v1";
    strategy: "cumulative-checkpoint";
    coversThroughMessageId: string;
    coveredMessageCount: number;
    basedOnSummaryMessageId?: string;
    generatedBy: {
      providerId: string;
      model: string;
      promptVersion?: string;
    };
    stats?: {
      sourceMessageCount: number;
      estimatedInputTokens?: number;
      outputTokens?: number;
    };
  };
};

export type StoredChatContextMeta = {
  schemaVersion: 3;
  systemPrompt?: string;
  tools?: Context["tools"];
  activeSegmentIndex: number;
  totalSegmentCount: number;
  totalMessageCount: number;
};

export type StoredContextSegment = {
  segmentIndex: number;
  segmentId: string;
  summary?: StoredSummaryMessage;
  messages: Message[];
  messageCount: number;
  startMessageId?: string;
  endMessageId?: string;
  createdAt: number;
  updatedAt: number;
};

export type HistoryMessageRef = {
  segmentIndex: number;
  messageIndex: number;
};

export type RenderSummaryCard = {
  kind: "summary";
  key: string;
  segmentIndex: number;
  summaryId: string;
  content: string;
  coveredMessageCount: number;
  coversThroughMessageId: string;
  generatedBy: {
    providerId: string;
    model: string;
    promptVersion?: string;
  };
  timestamp: number;
  collapsed: boolean;
};

export type RenderUserMessage = {
  kind: "user";
  key: string;
  segmentIndex: number;
  messageRef: HistoryMessageRef;
  text: string;
  attachments: PendingUploadedFile[];
  timestamp: number;
  isFromCompactedSegment: boolean;
};

export type RenderAssistantGroup = {
  kind: "assistant";
  key: string;
  segmentIndex: number;
  rounds: UiRound[];
  timestamp: number;
  isFromCompactedSegment: boolean;
};

export type RenderTimelineItem =
  | RenderSummaryCard
  | RenderUserMessage
  | RenderAssistantGroup;

export type ConversationViewState = {
  meta: StoredChatContextMeta;
  segments: StoredContextSegment[];
  historyRenderItems: RenderTimelineItem[];
  activeSegmentIndex: number;
};

function createEmptySegment(index: number, timestamp = Date.now()): StoredContextSegment {
  return {
    segmentIndex: index,
    segmentId: crypto.randomUUID(),
    messages: [],
    messageCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function isCompactionAssistantMessage(message: Message): message is AssistantMessage {
  return (
    message.role === "assistant" &&
    (message.api === "liveagent-compaction" ||
      (message.provider === "liveagent" && message.model === "summary"))
  );
}

function isRuntimeHistoryMessage(message: Message) {
  if (message.role === "assistant") return !isCompactionAssistantMessage(message);
  return message.role === "user" || message.role === "toolResult";
}

function getMessageTimestamp(message: Message | undefined) {
  if (!message) return Date.now();
  return typeof message.timestamp === "number" ? message.timestamp : Date.now();
}

function getMessageStableId(
  message: Message | undefined,
  segmentIndex: number,
  messageIndex: number,
) {
  const candidate =
    message &&
    typeof (message as { id?: unknown }).id === "string" &&
    String((message as { id?: unknown }).id).trim()
      ? String((message as { id?: unknown }).id).trim()
      : message?.role === "assistant" &&
          typeof message.responseId === "string" &&
          message.responseId.trim()
        ? message.responseId.trim()
        : undefined;
  if (candidate) return candidate;
  return `segment-${segmentIndex}-message-${messageIndex}-${getMessageTimestamp(message)}`;
}

function getSummaryId(summary: StoredSummaryMessage | undefined) {
  return summary?.id;
}

function countMessages(segments: StoredContextSegment[]) {
  return segments.reduce((sum, segment) => sum + segment.messages.length, 0);
}

function buildConversationMeta(params: {
  systemPrompt?: string;
  tools?: Context["tools"];
  segments: StoredContextSegment[];
  activeSegmentIndex?: number;
}): StoredChatContextMeta {
  const activeSegmentIndex =
    typeof params.activeSegmentIndex === "number"
      ? Math.max(0, Math.min(params.activeSegmentIndex, Math.max(0, params.segments.length - 1)))
      : Math.max(0, params.segments.length - 1);
  const systemPrompt = normalizeConversationSystemPrompt(params.systemPrompt);
  return {
    schemaVersion: 3,
    systemPrompt,
    tools: params.tools,
    activeSegmentIndex,
    totalSegmentCount: params.segments.length,
    totalMessageCount: countMessages(params.segments),
  };
}

function getAssistantPromptVersion(assistant: AssistantMessage) {
  const candidate = (assistant as AssistantMessage & { promptVersion?: unknown }).promptVersion;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : "summary-v1";
}

function appendCompactionCheckpointToSegments(
  segments: StoredContextSegment[],
  activeSegmentIndex: number,
  checkpointMessage: AssistantMessage,
) {
  const coveredMessageCount = countMessages(segments);
  if (coveredMessageCount === 0) {
    return {
      activeSegmentIndex,
      appended: false,
    };
  }

  const previousSegment = segments[activeSegmentIndex];
  if (!previousSegment || previousSegment.messages.length === 0) {
    return {
      activeSegmentIndex,
      appended: false,
    };
  }

  const previousMessageIndex = Math.max(0, previousSegment.messages.length - 1);
  const coversThroughMessageId =
    previousSegment.endMessageId ||
    getMessageStableId(
      previousSegment.messages[previousMessageIndex],
      activeSegmentIndex,
      previousMessageIndex,
    );
  const nextSegmentIndex = segments.length;
  const nextSegment = createEmptySegment(
    nextSegmentIndex,
    checkpointMessage.timestamp ?? Date.now(),
  );
  nextSegment.summary = createSummaryFromAssistant(checkpointMessage, {
    segmentIndex: nextSegmentIndex,
    coveredMessageCount,
    coversThroughMessageId,
    basedOnSummaryMessageId: getSummaryId(previousSegment.summary),
    sourceMessageCount: previousSegment.messages.length,
  });
  segments.push(nextSegment);

  return {
    activeSegmentIndex: nextSegmentIndex,
    appended: true,
  };
}

function createSummaryFromAssistant(
  assistant: AssistantMessage,
  params: {
    segmentIndex: number;
    coveredMessageCount: number;
    coversThroughMessageId: string;
    basedOnSummaryMessageId?: string;
    sourceMessageCount: number;
  },
): StoredSummaryMessage {
  const content = assistantMessageToText(assistant).trim();
  const summaryId =
    (typeof assistant.responseId === "string" && assistant.responseId.trim()) ||
    `summary-${params.segmentIndex}-${assistant.timestamp ?? Date.now()}`;

  return {
    role: "summary",
    id: summaryId,
    timestamp: assistant.timestamp ?? Date.now(),
    content,
    summaryMeta: {
      format: "plain-text-v1",
      strategy: "cumulative-checkpoint",
      coversThroughMessageId: params.coversThroughMessageId,
      coveredMessageCount: params.coveredMessageCount,
      basedOnSummaryMessageId: params.basedOnSummaryMessageId,
      generatedBy: {
        providerId:
          typeof assistant.provider === "string" && assistant.provider.trim()
            ? assistant.provider.trim()
            : "liveagent",
        model:
          typeof assistant.model === "string" && assistant.model.trim()
            ? assistant.model.trim()
            : "summary",
        promptVersion: getAssistantPromptVersion(assistant),
      },
      stats: {
        sourceMessageCount: params.sourceMessageCount,
        estimatedInputTokens:
          typeof assistant.usage?.input === "number" ? assistant.usage.input : undefined,
        outputTokens:
          typeof assistant.usage?.output === "number" ? assistant.usage.output : undefined,
      },
    },
  };
}

function normalizeSegment(
  segment: StoredContextSegment,
  segmentIndex: number,
): StoredContextSegment {
  const messages = segment.messages.filter((message, messageIndex) => {
    if (!isRuntimeHistoryMessage(message)) return false;
    if (
      segment.summary &&
      messageIndex === 0 &&
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.trim() === INTERNAL_RESUME_MESSAGE_TEXT
    ) {
      return false;
    }
    return true;
  });
  const messageCount = messages.length;
  const startMessageId =
    messageCount > 0 ? getMessageStableId(messages[0], segmentIndex, 0) : undefined;
  const endMessageId =
    messageCount > 0
      ? getMessageStableId(messages[messageCount - 1], segmentIndex, messageCount - 1)
      : undefined;
  const updatedAt =
    messageCount > 0
      ? getMessageTimestamp(messages[messageCount - 1])
      : segment.updatedAt || segment.createdAt || Date.now();

  return {
    segmentIndex,
    segmentId: segment.segmentId || crypto.randomUUID(),
    summary: segment.summary,
    messages,
    messageCount,
    startMessageId,
    endMessageId,
    createdAt: segment.createdAt || updatedAt,
    updatedAt,
  };
}

export function appendSummaryToSystemPrompt(
  baseSystemPrompt: string | undefined,
  summaryContent: string | undefined,
) {
  if (!summaryContent?.trim()) return baseSystemPrompt;

  const summaryBlock = [
    "",
    "## Previous Conversation Summary",
    "",
    "The following is a compressed summary of the earlier conversation. Use it to understand the context,",
    "but do not repeat work that has already been completed.",
    "",
    summaryContent.trim(),
    "",
  ].join("\n");

  const base = (baseSystemPrompt || "").trim();
  return base ? `${base}\n${summaryBlock}` : summaryBlock.trim();
}

export function flattenSegmentsToTimeline(
  segments: StoredContextSegment[],
  activeSegmentIndex: number,
): RenderTimelineItem[] {
  const items: RenderTimelineItem[] = [];

  for (const segment of segments) {
    items.push(...buildTimelineItemsForSegment(segment, segment.segmentIndex < activeSegmentIndex));
  }

  return items;
}

function buildTimelineItemsForSegment(
  segment: StoredContextSegment,
  isCompacted: boolean,
): RenderTimelineItem[] {
  const items: RenderTimelineItem[] = [];

  if (segment.summary) {
    items.push({
      kind: "summary",
      key: `summary-${segment.segmentIndex}-${segment.summary.id}`,
      segmentIndex: segment.segmentIndex,
      summaryId: segment.summary.id,
      content: segment.summary.content,
      coveredMessageCount: segment.summary.summaryMeta.coveredMessageCount,
      coversThroughMessageId: segment.summary.summaryMeta.coversThroughMessageId,
      generatedBy: segment.summary.summaryMeta.generatedBy,
      timestamp: segment.summary.timestamp,
      collapsed: true,
    });
  }

  const uiMessages = buildUiMessages(segment.messages);
  for (const uiMessage of uiMessages) {
    if (uiMessage.role === "user") {
      const localMessageIndex = uiMessage.messageIndex ?? 0;
      const source = segment.messages[localMessageIndex];
      items.push({
        kind: "user",
        key: `segment-${segment.segmentIndex}-${uiMessage.key}`,
        segmentIndex: segment.segmentIndex,
        messageRef: {
          segmentIndex: segment.segmentIndex,
          messageIndex: localMessageIndex,
        },
        text: uiMessage.text,
        attachments: uiMessage.attachments ?? [],
        timestamp: getMessageTimestamp(source),
        isFromCompactedSegment: isCompacted,
      });
      continue;
    }

    items.push({
      kind: "assistant",
      key: `segment-${segment.segmentIndex}-${uiMessage.key}`,
      segmentIndex: segment.segmentIndex,
      rounds: uiMessage.rounds ?? [],
      timestamp: getMessageTimestamp(segment.messages[segment.messages.length - 1]),
      isFromCompactedSegment: isCompacted,
    });
  }

  return items;
}

function markTimelineItemCompacted(item: RenderTimelineItem): RenderTimelineItem {
  if (item.kind === "summary" || item.isFromCompactedSegment) {
    return item;
  }

  return {
    ...item,
    isFromCompactedSegment: true,
  };
}

function buildUpdatedTimelineForActiveSegment(params: {
  previousItems: RenderTimelineItem[];
  segments: StoredContextSegment[];
  activeSegmentIndex: number;
}) {
  const { previousItems, segments, activeSegmentIndex } = params;
  const preserved = previousItems
    .filter((item) => item.segmentIndex < activeSegmentIndex)
    .map(markTimelineItemCompacted);
  const activeSegment = segments[activeSegmentIndex];
  const activeItems = activeSegment
    ? buildTimelineItemsForSegment(activeSegment, false)
    : [];
  return [...preserved, ...activeItems];
}

function rebuildTimelineFromSegment(params: {
  previousItems: RenderTimelineItem[];
  segments: StoredContextSegment[];
  activeSegmentIndex: number;
  startSegmentIndex: number;
}) {
  const { previousItems, segments, activeSegmentIndex, startSegmentIndex } = params;
  const preserved = previousItems
    .filter((item) => item.segmentIndex < startSegmentIndex)
    .map((item) => (item.segmentIndex < activeSegmentIndex ? markTimelineItemCompacted(item) : item));
  const rebuilt = segments
    .filter((segment) => segment.segmentIndex >= startSegmentIndex)
    .flatMap((segment) =>
      buildTimelineItemsForSegment(segment, segment.segmentIndex < activeSegmentIndex),
    );
  return [...preserved, ...rebuilt];
}

export function normalizeConversationState(input: {
  meta: Pick<StoredChatContextMeta, "systemPrompt" | "tools"> &
    Partial<Omit<StoredChatContextMeta, "schemaVersion" | "systemPrompt" | "tools">>;
  segments: StoredContextSegment[];
}): ConversationViewState {
  const rawSegments = input.segments.length > 0 ? input.segments : [createEmptySegment(0)];
  const segments = rawSegments
    .slice()
    .sort((a, b) => a.segmentIndex - b.segmentIndex)
    .map((segment, index) => normalizeSegment(segment, index));
  const activeSegmentIndex = Math.max(0, segments.length - 1);
  const meta = buildConversationMeta({
    systemPrompt: input.meta.systemPrompt,
    tools: input.meta.tools,
    segments,
    activeSegmentIndex,
  });

  return {
    meta,
    segments,
    activeSegmentIndex,
    historyRenderItems: flattenSegmentsToTimeline(segments, activeSegmentIndex),
  };
}

export function createConversationStateFromContext(context: Context): ConversationViewState {
  const seed = normalizeConversationState({
    meta: {
      systemPrompt: context.systemPrompt,
      tools: context.tools,
    },
    segments: [createEmptySegment(0)],
  });

  return appendMessagesToConversation(seed, context.messages);
}

export function buildRequestContext(
  state: ConversationViewState,
  options?: { includeAbortedMessages?: boolean; includeUploadedFilesMetadata?: boolean },
): Context {
  const activeSegment = state.segments[state.activeSegmentIndex] ?? createEmptySegment(0);
  const runtimeMessages = options?.includeUploadedFilesMetadata
    ? activeSegment.messages
    : activeSegment.messages.map(stripUploadedFilesMessageMetadata);
  const next: Context = {
    messages: options?.includeAbortedMessages
      ? sanitizeMessagesForModelContext(runtimeMessages)
      : sanitizeMessagesForContinuation(runtimeMessages),
  };

  const systemPrompt = appendSummaryToSystemPrompt(
    state.meta.systemPrompt,
    activeSegment.summary?.content,
  );
  if (typeof systemPrompt === "string") {
    next.systemPrompt = systemPrompt;
  }
  if (Array.isArray(state.meta.tools)) {
    next.tools = state.meta.tools;
  }

  return next;
}

export function getActiveSegment(state: ConversationViewState) {
  return state.segments[state.activeSegmentIndex] ?? state.segments[state.segments.length - 1];
}

export function applyCompactionCheckpoint(
  state: ConversationViewState,
  checkpointMessage: AssistantMessage,
): ConversationViewState {
  if (!isCompactionAssistantMessage(checkpointMessage)) {
    return state;
  }
  return appendMessagesToConversation(state, [checkpointMessage]);
}

export function appendMessagesToConversation(
  state: ConversationViewState,
  incomingMessages: Message[],
): ConversationViewState {
  if (incomingMessages.length === 0) return state;

  const segments = state.segments.map((segment) => ({
    ...segment,
    messages: segment.messages.slice(),
  }));
  let activeSegmentIndex = Math.min(
    Math.max(0, state.activeSegmentIndex),
    Math.max(0, segments.length - 1),
  );
  const changedSegmentIndexes = new Set<number>();

  for (const message of incomingMessages) {
    if (isCompactionAssistantMessage(message)) {
      const checkpoint = appendCompactionCheckpointToSegments(segments, activeSegmentIndex, message);
      if (checkpoint.appended) {
        activeSegmentIndex = checkpoint.activeSegmentIndex;
        changedSegmentIndexes.add(activeSegmentIndex);
      }
      continue;
    }

    if (!isRuntimeHistoryMessage(message)) continue;
    segments[activeSegmentIndex].messages.push(message);
    segments[activeSegmentIndex].updatedAt = getMessageTimestamp(message);
    changedSegmentIndexes.add(activeSegmentIndex);
  }

  if (changedSegmentIndexes.size === 0) return state;

  const normalizedSegments = segments.map((segment, index) =>
    changedSegmentIndexes.has(index) ? normalizeSegment(segment, index) : segment,
  );
  const meta = buildConversationMeta({
    systemPrompt: state.meta.systemPrompt,
    tools: state.meta.tools,
    segments: normalizedSegments,
    activeSegmentIndex,
  });

  return {
    meta,
    segments: normalizedSegments,
    activeSegmentIndex,
    historyRenderItems: buildUpdatedTimelineForActiveSegment({
      previousItems: state.historyRenderItems,
      segments: normalizedSegments,
      activeSegmentIndex,
    }),
  };
}

export function truncateConversationFromMessage(
  state: ConversationViewState,
  ref: HistoryMessageRef,
): ConversationViewState {
  const targetSegment = state.segments[ref.segmentIndex];
  if (!targetSegment) return state;

  const segments = state.segments
    .slice(0, ref.segmentIndex + 1)
    .map((segment) => ({
      ...segment,
      messages: segment.messages.slice(),
    }));
  const target = segments[ref.segmentIndex];
  const cutoff = Math.max(0, Math.min(ref.messageIndex, target.messages.length));
  target.messages = target.messages.slice(0, cutoff);
  target.updatedAt =
    cutoff > 0
      ? getMessageTimestamp(target.messages[cutoff - 1])
      : target.createdAt;
  const normalizedSegments = segments.map((segment, index) =>
    index === ref.segmentIndex ? normalizeSegment(segment, index) : segment,
  );
  const activeSegmentIndex = Math.max(0, normalizedSegments.length - 1);
  const meta = buildConversationMeta({
    systemPrompt: state.meta.systemPrompt,
    tools: state.meta.tools,
    segments: normalizedSegments,
    activeSegmentIndex,
  });

  return {
    meta,
    segments: normalizedSegments,
    activeSegmentIndex,
    historyRenderItems: rebuildTimelineFromSegment({
      previousItems: state.historyRenderItems,
      segments: normalizedSegments,
      activeSegmentIndex,
      startSegmentIndex: ref.segmentIndex,
    }),
  };
}

export function replaceActiveSegmentMessages(
  state: ConversationViewState,
  messages: Message[],
): ConversationViewState {
  const activeSegment = state.segments[state.activeSegmentIndex];
  if (!activeSegment) return state;

  const segments = state.segments.map((segment, index) =>
    index === state.activeSegmentIndex
      ? {
          ...segment,
          messages: messages.slice(),
          updatedAt:
            messages.length > 0
              ? getMessageTimestamp(messages[messages.length - 1])
              : segment.createdAt,
        }
      : segment,
  );
  const normalizedSegments = segments.map((segment, index) =>
    index === state.activeSegmentIndex ? normalizeSegment(segment, index) : segment,
  );
  const meta = buildConversationMeta({
    systemPrompt: state.meta.systemPrompt,
    tools: state.meta.tools,
    segments: normalizedSegments,
    activeSegmentIndex: state.activeSegmentIndex,
  });

  return {
    meta,
    segments: normalizedSegments,
    activeSegmentIndex: state.activeSegmentIndex,
    historyRenderItems: buildUpdatedTimelineForActiveSegment({
      previousItems: state.historyRenderItems,
      segments: normalizedSegments,
      activeSegmentIndex: state.activeSegmentIndex,
    }),
  };
}
