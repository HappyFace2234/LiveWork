import {
  type HostedSearchBlock,
  type HostedSearchSource,
  type HostedSearchStatus,
  mergeHostedSearchBlocks,
  normalizeHostedSearchStatus,
} from "../chat/messages/hostedSearch";
import type { ProviderId } from "../settings";

type HostedSearchUpdate = {
  id?: string;
  provider?: string;
  status?: HostedSearchStatus;
  queries?: string[];
  sources?: HostedSearchSource[];
};

type HostedSearchAggregator = {
  accept: (rawEvent: unknown) => void;
  complete: () => HostedSearchBlock[];
  fail: () => HostedSearchBlock[];
  dispose: () => HostedSearchBlock[];
  getBlocks: () => HostedSearchBlock[];
};

type FetchProbe = {
  providerId: ProviderId;
  sessionId?: string;
  requestId?: string;
  active: boolean;
  claimed: boolean;
  parseDone?: Promise<void>;
  onRawEvent: (event: unknown) => void;
};

type HostedSearchFetchProbeController = {
  finish: () => Promise<void>;
};

const activeFetchProbes = new Set<FetchProbe>();
let originalFetch: typeof globalThis.fetch | null = null;
let hostedSearchProbeSequence = 0;

export const HOSTED_SEARCH_PROBE_HEADER = "x-liveagent-hosted-search-probe";

export function createHostedSearchProbeId(providerId: ProviderId) {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${++hostedSearchProbeSequence}`;
  return `hosted-search-${providerId}-${random}`;
}

export function withHostedSearchProbeHeader(
  headers: Record<string, string> | undefined,
  requestId: string | undefined,
): Record<string, string> | undefined {
  if (!requestId) return headers;
  return {
    ...(headers ?? {}),
    [HOSTED_SEARCH_PROBE_HEADER]: requestId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function maybeParseJson(value: string): unknown {
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeRequestBody(body: unknown): unknown {
  if (typeof body === "string") return maybeParseJson(body);
  if (body instanceof Uint8Array) {
    return maybeParseJson(new TextDecoder().decode(body));
  }
  return undefined;
}

function getRequestBody(input: RequestInfo | URL, init?: RequestInit): unknown {
  const initBody = normalizeRequestBody(init?.body);
  if (initBody !== undefined) return initBody;
  if (typeof Request !== "undefined" && input instanceof Request) {
    return normalizeRequestBody(input.body);
  }
  return undefined;
}

function getRequestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return "";
}

function readHeader(headers: HeadersInit | undefined, name: string) {
  if (!headers) return "";
  try {
    return new Headers(headers).get(name)?.trim() ?? "";
  } catch {
    return "";
  }
}

function getRequestHeader(input: RequestInfo | URL, init: RequestInit | undefined, name: string) {
  const initHeader = readHeader(init?.headers, name);
  if (initHeader) return initHeader;
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.headers.get(name)?.trim() ?? "";
  }
  return "";
}

function getProviderPath(providerId: ProviderId) {
  return `/proxy/${providerId}`;
}

function requestBodyMatchesProbe(probe: FetchProbe, body: unknown) {
  if (!probe.sessionId) return true;
  if (!isRecord(body)) return false;

  if (probe.providerId === "codex") {
    const promptCacheKey = readString(body.prompt_cache_key);
    return promptCacheKey === probe.sessionId;
  }

  if (probe.providerId === "claude_code") {
    const metadata = isRecord(body.metadata) ? body.metadata : {};
    const userId = readString(metadata.user_id);
    return userId === probe.sessionId;
  }

  return false;
}

function isStreamLikeResponse(response: Response) {
  if (!response.body) return false;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return (
    contentType.includes("event-stream") ||
    contentType.includes("stream") ||
    contentType.includes("json")
  );
}

function requestMatchesProbe(
  probe: FetchProbe,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response,
) {
  if (!probe.active || probe.claimed || !isStreamLikeResponse(response)) return false;
  const url = getRequestUrl(input);
  if (!url.includes(getProviderPath(probe.providerId))) return false;
  const requestId = getRequestHeader(input, init, HOSTED_SEARCH_PROBE_HEADER);
  if (probe.requestId) {
    if (requestId) return requestId === probe.requestId;
    if (probe.providerId === "gemini") return false;
  }
  return requestBodyMatchesProbe(probe, getRequestBody(input, init));
}

function installFetchProbe() {
  if (originalFetch || typeof globalThis.fetch !== "function") return;
  originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch!(input, init);
    const probe = [...activeFetchProbes].find((candidate) =>
      requestMatchesProbe(candidate, input, init, response),
    );
    if (probe) {
      probe.claimed = true;
      probe.parseDone = parseResponseClone(response, probe);
      void probe.parseDone;
    }
    return response;
  }) as typeof globalThis.fetch;
}

function uninstallFetchProbeIfIdle() {
  if (activeFetchProbes.size > 0 || !originalFetch) return;
  globalThis.fetch = originalFetch;
  originalFetch = null;
}

function emitJsonCandidate(text: string, probe: FetchProbe) {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "[DONE]") return;
  const parsed = maybeParseJson(trimmed);
  if (Array.isArray(parsed)) {
    parsed.forEach((item) => {
      probe.onRawEvent(item);
    });
    return;
  }
  if (parsed !== undefined) {
    probe.onRawEvent(parsed);
  }
}

function consumeTextBuffer(buffer: string, probe: FetchProbe, final = false): string {
  const lines = buffer.split(/\r?\n/g);
  const tail = final ? "" : (lines.pop() ?? "");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("data:")) {
      emitJsonCandidate(trimmed.slice(5), probe);
      continue;
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      emitJsonCandidate(trimmed, probe);
    }
  }
  if (final && tail.trim()) {
    emitJsonCandidate(tail, probe);
  }
  return tail;
}

async function parseResponseClone(response: Response, probe: FetchProbe) {
  try {
    const clone = response.clone();
    const reader = clone.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeTextBuffer(buffer, probe);
    }
    buffer += decoder.decode();
    consumeTextBuffer(buffer, probe, true);
  } catch {
    // Search metadata is best-effort; never break the provider stream.
  }
}

export function startHostedSearchFetchProbe(params: {
  providerId: ProviderId;
  sessionId?: string;
  requestId?: string;
  enabled?: boolean;
  onRawEvent: (event: unknown) => void;
}): HostedSearchFetchProbeController {
  if (!params.enabled || typeof globalThis.fetch !== "function") {
    return { async finish() {} };
  }

  const probe: FetchProbe = {
    providerId: params.providerId,
    sessionId: params.sessionId,
    requestId: params.requestId,
    active: true,
    claimed: false,
    onRawEvent: params.onRawEvent,
  };
  activeFetchProbes.add(probe);
  installFetchProbe();

  return {
    async finish() {
      probe.active = false;
      activeFetchProbes.delete(probe);
      uninstallFetchProbeIfIdle();
      await probe.parseDone;
    },
  };
}

function normalizedType(value: unknown) {
  return readString(value).replace(/-/g, "_").toLowerCase();
}

function hasRecordMatching(
  value: unknown,
  matches: (record: Record<string, unknown>) => boolean,
): boolean {
  if (Array.isArray(value)) return value.some((item) => hasRecordMatching(item, matches));
  if (!isRecord(value)) return false;
  if (matches(value)) return true;
  return Object.values(value).some((child) => hasRecordMatching(child, matches));
}

function isOpenAIWebSearchRecord(record: Record<string, unknown>) {
  const type = normalizedType(record.type);
  return type === "web_search_call" || type.startsWith("web_search_call_");
}

function isOpenAIUrlCitationRecord(record: Record<string, unknown>) {
  return normalizedType(record.type) === "url_citation";
}

function hasOpenAISearchSignal(value: unknown) {
  if (!isRecord(value)) return false;
  const eventType = normalizedType(value.type);
  if (eventType.includes("web_search_call")) return true;
  if (eventType.includes("output_text.annotation")) {
    const annotation = isRecord(value.annotation) ? value.annotation : {};
    return isOpenAIUrlCitationRecord(annotation);
  }
  const item = isRecord(value.item) ? value.item : {};
  if (isOpenAIWebSearchRecord(item)) return true;
  return hasRecordMatching(
    value,
    (record) => isOpenAIWebSearchRecord(record) || isOpenAIUrlCitationRecord(record),
  );
}

function isAnthropicWebSearchRecord(record: Record<string, unknown>) {
  const type = normalizedType(record.type);
  const name = readString(record.name).toLowerCase();
  return (
    (type === "server_tool_use" && name === "web_search") ||
    type === "web_search_tool_result" ||
    type === "web_search_result" ||
    type === "webpage_location" ||
    (name === "web_search" && type.includes("tool"))
  );
}

function hasAnthropicSearchSignal(value: unknown) {
  if (!isRecord(value)) return false;
  const eventType = normalizedType(value.type);
  if (eventType.includes("web_search")) return true;
  const contentBlock = isRecord(value.content_block) ? value.content_block : {};
  if (isAnthropicWebSearchRecord(contentBlock)) return true;
  return hasRecordMatching(value, isAnthropicWebSearchRecord);
}

function hasGeminiGroundingSignal(value: unknown) {
  return hasRecordMatching(value, (record) => {
    if (isRecord(record.groundingMetadata)) return true;
    if (Array.isArray(record.groundingChunks)) return true;
    if (Array.isArray(record.webSearchQueries)) return true;
    return false;
  });
}

function hasSearchSignal(providerId: ProviderId, value: unknown): boolean {
  if (providerId === "codex") return hasOpenAISearchSignal(value);
  if (providerId === "claude_code") return hasAnthropicSearchSignal(value);
  if (providerId === "gemini") return hasGeminiGroundingSignal(value);
  return false;
}

function collectQueries(value: unknown, out: string[] = [], keyHint = ""): string[] {
  if (typeof value === "string") {
    const normalizedHint = keyHint.toLowerCase();
    if (
      normalizedHint === "query" ||
      normalizedHint === "search_query" ||
      normalizedHint === "searchquery" ||
      normalizedHint === "websearchqueries"
    ) {
      const text = value.replace(/\s+/g, " ").trim();
      if (text && text.length <= 500 && !out.includes(text)) out.push(text);
    }
    return out;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => {
      collectQueries(item, out, keyHint);
    });
    return out;
  }

  if (!isRecord(value)) return out;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
    if (Array.isArray(child) && normalizedKey === "websearchqueries") {
      child.forEach((item) => {
        collectQueries(item, out, "webSearchQueries");
      });
      continue;
    }
    collectQueries(child, out, key);
  }
  return out;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function collectSources(value: unknown, out = new Map<string, HostedSearchSource>()) {
  if (Array.isArray(value)) {
    value.forEach((item) => {
      collectSources(item, out);
    });
    return out;
  }
  if (!isRecord(value)) return out;

  const directUrl = readString(value.url ?? value.uri);
  if (directUrl && isHttpUrl(directUrl)) {
    const existing = out.get(directUrl);
    const type = readString(value.type);
    const sourceType =
      type === "url_citation" ||
      value.cited_text ||
      value.citedText ||
      existing?.sourceType === "citation"
        ? "citation"
        : "source";
    const title = readString(value.title ?? value.name) || existing?.title;
    const snippet = readString(value.snippet ?? value.description) || existing?.snippet;
    const citedText = readString(value.cited_text ?? value.citedText) || existing?.citedText;
    out.set(directUrl, {
      url: directUrl,
      ...(title ? { title } : {}),
      ...(snippet ? { snippet } : {}),
      ...(citedText ? { citedText } : {}),
      sourceType,
    });
  }

  for (const child of Object.values(value)) {
    collectSources(child, out);
  }
  return out;
}

function findFirstSearchRecordId(
  value: unknown,
  matches: (record: Record<string, unknown>) => boolean,
): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = findFirstSearchRecordId(item, matches);
      if (id) return id;
    }
    return "";
  }
  if (!isRecord(value)) return "";
  if (matches(value)) {
    const id = readString(value.id) || readString(value.call_id) || readString(value.tool_use_id);
    if (id) return id;
  }
  for (const child of Object.values(value)) {
    const id = findFirstSearchRecordId(child, matches);
    if (id) return id;
  }
  return "";
}

function readExplicitSearchId(providerId: ProviderId, raw: unknown) {
  if (!isRecord(raw)) return "";

  if (providerId === "codex") {
    const eventType = normalizedType(raw.type);
    if (eventType.includes("output_text.annotation")) return "";
    if (eventType.includes("web_search_call")) {
      return readString(raw.item_id) || readString(raw.output_item_id);
    }
    return findFirstSearchRecordId(raw, isOpenAIWebSearchRecord);
  }

  if (providerId === "claude_code") {
    return findFirstSearchRecordId(raw, isAnthropicWebSearchRecord);
  }

  const item = isRecord(raw.item) ? raw.item : {};
  const contentBlock = isRecord(raw.content_block) ? raw.content_block : {};
  return (
    readString(raw.item_id) ||
    readString(raw.tool_use_id) ||
    readString(item.id) ||
    readString(item.call_id) ||
    readString(contentBlock.id) ||
    readString(contentBlock.tool_use_id)
  );
}

function readRawStatus(raw: unknown, sources: HostedSearchSource[]): HostedSearchStatus {
  const record = isRecord(raw) ? raw : {};
  const item = isRecord(record.item) ? record.item : {};
  const statusText = [readString(record.type), readString(record.status), readString(item.status)]
    .join(" ")
    .toLowerCase();

  if (/fail|error|cancel/.test(statusText)) return "failed";
  if (/complete|completed|done|succeeded|finished/.test(statusText)) return "completed";
  if (/searching|in_progress|started|added/.test(statusText)) return "searching";
  return sources.length > 0 ? "completed" : "searching";
}

function normalizeRawHostedSearchUpdate(
  providerId: ProviderId,
  raw: unknown,
): HostedSearchUpdate | null {
  if (!hasSearchSignal(providerId, raw)) return null;
  const queries = collectQueries(raw);
  const sources = [...collectSources(raw).values()];
  const status = readRawStatus(raw, sources);
  const id = readExplicitSearchId(providerId, raw);

  if (!id && queries.length === 0 && sources.length === 0 && status === "searching") {
    return null;
  }

  return {
    ...(id ? { id } : {}),
    provider: providerId,
    status,
    queries,
    sources,
  };
}

export function createHostedSearchEventAggregator(params: {
  providerId: ProviderId;
  onHostedSearch?: (block: HostedSearchBlock) => void;
}): HostedSearchAggregator {
  const blocksById = new Map<string, HostedSearchBlock>();
  const signaturesById = new Map<string, string>();
  const fallbackId = `hosted-search-${params.providerId}`;
  let lastId = fallbackId;

  const blockSignature = (block: HostedSearchBlock) =>
    safeStringify({
      type: block.type,
      id: block.id,
      provider: block.provider,
      status: block.status,
      queries: block.queries,
      sources: block.sources,
    });

  const publish = (block: HostedSearchBlock) => {
    const signature = blockSignature(block);
    if (signaturesById.get(block.id) === signature) return block;
    blocksById.set(block.id, block);
    signaturesById.set(block.id, signature);
    params.onHostedSearch?.(block);
    return block;
  };

  const emit = (update: HostedSearchUpdate) => {
    const derivedId =
      update.id?.trim() ||
      (update.queries?.length
        ? `hosted-search-${params.providerId}-${stableHash(update.queries.join("|"))}`
        : lastId);
    lastId = derivedId;
    const incoming: HostedSearchBlock = {
      type: "hostedSearch",
      id: derivedId,
      provider: update.provider ?? params.providerId,
      status: normalizeHostedSearchStatus(update.status),
      queries: update.queries ?? [],
      sources: update.sources ?? [],
      updatedAt: Date.now(),
    };
    const merged = mergeHostedSearchBlocks(blocksById.get(derivedId), incoming);
    publish(merged);
  };

  const finalize = (status: HostedSearchStatus | null, emitUpdates: boolean) => {
    const out: HostedSearchBlock[] = [];
    for (const block of blocksById.values()) {
      const next =
        status && block.status === "searching"
          ? { ...block, status, updatedAt: Date.now() }
          : block;
      if (emitUpdates) {
        publish(next);
      } else {
        blocksById.set(next.id, next);
      }
      out.push(next);
    }
    return out;
  };

  return {
    accept(rawEvent) {
      const update = normalizeRawHostedSearchUpdate(params.providerId, rawEvent);
      if (!update) return;
      emit(update);
    },
    complete() {
      return finalize("completed", true);
    },
    fail() {
      return finalize("failed", true);
    },
    dispose() {
      return finalize(null, false);
    },
    getBlocks() {
      return [...blocksById.values()];
    },
  };
}
