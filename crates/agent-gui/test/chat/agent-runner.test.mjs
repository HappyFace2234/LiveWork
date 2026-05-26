import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const llmModulePath = path.join(rootDir, "src/lib/providers/llm.ts");
const proxyModulePath = path.join(rootDir, "src/lib/providers/proxy.ts");
const powerActivityModulePath = path.join(rootDir, "src/lib/system/powerActivity.ts");

const streamQueue = [];
const streamSideEffects = [];
const observedStreamContexts = [];
const HOSTED_SEARCH_PROBE_HEADER = "x-liveagent-hosted-search-probe";

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createAssistant(content, stopReason = "stop", extra = {}) {
  return {
    role: "assistant",
    content,
    api: extra.api ?? "openai-responses",
    provider: extra.provider ?? "openai",
    model: extra.model ?? "gpt-5",
    usage: extra.usage ?? createUsage(),
    stopReason,
    errorMessage: extra.errorMessage,
    timestamp: extra.timestamp ?? Date.now(),
  };
}

function createTextAssistant(text, stopReason = "stop", extra = {}) {
  return createAssistant([{ type: "text", text }], stopReason, extra);
}

function createToolUseAssistant(toolCall, extra = {}) {
  return createAssistant([toolCall], "toolUse", extra);
}

function createToolResult(toolCall, text = "ok") {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details: { ok: true },
    isError: false,
    timestamp: Date.now(),
  };
}

function createStreamForAssistant(assistant) {
  const events = [
    {
      type: "start",
      partial: {
        ...assistant,
        content: [],
      },
    },
  ];

  const partialContent = [];
  assistant.content.forEach((block, contentIndex) => {
    partialContent[contentIndex] = block;
    const partial = {
      ...assistant,
      content: partialContent.slice(),
    };
    if (block.type === "text") {
      events.push({
        type: "text_delta",
        contentIndex,
        delta: block.text,
        partial,
      });
      events.push({
        type: "text_end",
        contentIndex,
        content: block.text,
        partial,
      });
      return;
    }
    if (block.type === "thinking") {
      events.push({
        type: "thinking_delta",
        contentIndex,
        delta: block.thinking,
        partial,
      });
      return;
    }
    if (block.type === "toolCall") {
      events.push({
        type: "toolcall_start",
        contentIndex,
        partial,
      });
      events.push({
        type: "toolcall_end",
        contentIndex,
        toolCall: block,
        partial,
      });
    }
  });

  events.push({
    type: assistant.stopReason === "error" || assistant.stopReason === "aborted" ? "error" : "done",
    message: assistant,
  });

  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    async result() {
      return assistant;
    },
  };
}

const llmMock = {
  buildProviderRequestMetadata(_providerId, sessionId) {
    return sessionId ? { sessionId } : undefined;
  },
  buildDualAuthHeaders(apiKey) {
    return {
      Authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
    };
  },
  buildProviderAuthHeaders(_providerId, apiKey) {
    return {
      Authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
    };
  },
  createModelFromConfig(providerId, modelId, baseUrl) {
    return {
      id: modelId,
      name: modelId,
      api: "openai-responses",
      provider: providerId === "codex" ? "openai" : "anthropic",
      baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    };
  },
  finalizeProviderStreamOptions({ options }) {
    return options;
  },
  normalizeErrorMessage(value, fallback = "Request failed") {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  },
  resolveProviderCacheRetention(_providerId, _enabled, override) {
    return override ?? "none";
  },
  toSimpleStreamReasoning(value) {
    return value && value !== "off" ? value : undefined;
  },
  createStreamingTextReconciler() {
    const emittedTextByKey = new Map();
    return {
      appendDelta(key, delta) {
        if (!delta) return "";
        emittedTextByKey.set(key, `${emittedTextByKey.get(key) ?? ""}${delta}`);
        return delta;
      },
      reconcileFinalText(key, finalText) {
        const previous = emittedTextByKey.get(key) ?? "";
        emittedTextByKey.set(key, finalText);
        if (!previous) return finalText;
        return finalText.startsWith(previous) ? finalText.slice(previous.length) : "";
      },
    };
  },
  streamSimpleByApi(_model, context, options) {
    observedStreamContexts.push(context);
    const assistant = streamQueue.shift();
    if (!assistant) {
      throw new Error("No fake stream response queued");
    }
    const beforeStream = streamSideEffects.shift()?.(options);
    const stream = createStreamForAssistant(assistant);
    return {
      async *[Symbol.asyncIterator]() {
        await beforeStream;
        yield* stream;
      },
      async result() {
        await beforeStream;
        return stream.result();
      },
    };
  },
};

const loader = createTsModuleLoader({
  mocks: {
    [llmModulePath]: llmMock,
    [proxyModulePath]: {
      async prepareProxyRequest(_providerId, baseUrl) {
        return { baseUrl, headers: { "x-liveagent-test": "1" } };
      },
    },
    [powerActivityModulePath]: {
      async withPowerActivity(_scope, _reason, run) {
        return run();
      },
    },
  },
});

const { runAssistantWithTools } = loader.loadModule("src/lib/chat/runner/agentRunner.ts");
const { createSubagentScheduler } = loader.loadModule(
  "src/lib/chat/subagent/subagentScheduler.ts",
);

function resetFakeStreams(...assistants) {
  streamQueue.length = 0;
  streamQueue.push(...assistants);
  streamSideEffects.length = 0;
  observedStreamContexts.length = 0;
}

function queueStreamSideEffect(sideEffect) {
  streamSideEffects.push(sideEffect);
}

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function delayedSseResponse(event) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(encoder.encode(sse(event)));
          controller.close();
        }, 5);
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

function createBaseParams(overrides = {}) {
  const executedToolCalls = [];
  const textDeltas = [];
  return {
    params: {
      providerId: "codex",
      model: "gpt-5",
      runtime: {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        reasoning: "medium",
      },
      context: {
        systemPrompt: "Base system prompt",
        messages: [{ role: "user", content: "Start", timestamp: 1 }],
        tools: [
          {
            name: "Read",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      workdir: "/tmp/liveagent-test",
      sessionId: "session-1",
      tools: [
        {
          name: "Read",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        },
      ],
      async executeToolCall(toolCall) {
        executedToolCalls.push(toolCall);
        return createToolResult(toolCall, `result:${toolCall.name}`);
      },
      onTextDelta(delta) {
        textDeltas.push(delta);
      },
      ...overrides,
    },
    executedToolCalls,
    textDeltas,
  };
}

test("runAssistantWithTools returns terminal stop messages without scheduling a next-turn override", async () => {
  resetFakeStreams(createTextAssistant("done"));
  let beforeNextTurnCalls = 0;
  const { params, textDeltas } = createBaseParams({
    onBeforeNextTurn: async () => {
      beforeNextTurnCalls += 1;
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(beforeNextTurnCalls, 0);
  assert.equal(textDeltas.join(""), "done");
  assert.equal(result.assistant.stopReason, "stop");
  assert.equal(result.emittedMessages.length, 1);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[1].role, "assistant");
});

test("runAssistantWithTools waits for delayed hosted search probe finalization", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  const hostedSearchEvents = [];

  globalThis.fetch = async (_input, init) => {
    fetchCalled = true;
    const probeHeader = new Headers(init?.headers).get(HOSTED_SEARCH_PROBE_HEADER);
    assert.equal(probeHeader?.startsWith("hosted-search-codex-"), true);
    return delayedSseResponse({
      type: "response.output_item.added",
      item: {
        type: "web_search_call",
        id: "search-delayed",
        status: "in_progress",
        action: { query: "delayed hosted search" },
      },
    });
  };

  try {
    resetFakeStreams(createTextAssistant("answer"));
    queueStreamSideEffect((options) =>
      fetch("http://127.0.0.1:18080/proxy/codex/v1/responses", {
        method: "POST",
        headers: options?.headers,
        body: JSON.stringify({ prompt_cache_key: "session-1" }),
      }),
    );
    const { params } = createBaseParams({
      nativeWebSearch: true,
      onHostedSearch: (hostedSearch) => hostedSearchEvents.push(hostedSearch),
    });

    const result = await runAssistantWithTools(params);
    const finalHostedSearch = hostedSearchEvents[hostedSearchEvents.length - 1];
    const assistantHostedSearches = result.assistant.content.filter(
      (block) => block?.type === "hostedSearch",
    );

    assert.equal(fetchCalled, true);
    assert.equal(finalHostedSearch?.id, "search-delayed");
    assert.equal(finalHostedSearch?.status, "completed");
    assert.deepEqual(finalHostedSearch?.queries, ["delayed hosted search"]);
    assert.equal(assistantHostedSearches.length, 1);
    assert.equal(assistantHostedSearches[0].status, "completed");
  } finally {
    await Promise.resolve();
    globalThis.fetch = originalFetch;
  }
});

test("runAssistantWithTools calls onBeforeNextTurn only for toolUse turns with tool results", async () => {
  const toolCall = {
    type: "toolCall",
    id: "call-read",
    name: "Read",
    arguments: { path: "src/App.tsx" },
  };
  resetFakeStreams(
    createToolUseAssistant(toolCall),
    createTextAssistant("final answer"),
  );
  const beforeNextTurnSnapshots = [];
  const { params, executedToolCalls, textDeltas } = createBaseParams({
    onBeforeNextTurn: async (snapshot) => {
      beforeNextTurnSnapshots.push(snapshot);
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].id, toolCall.id);
  assert.equal(beforeNextTurnSnapshots.length, 1);
  assert.equal(beforeNextTurnSnapshots[0].assistant.stopReason, "toolUse");
  assert.equal(beforeNextTurnSnapshots[0].toolResults.length, 1);
  assert.deepEqual(
    beforeNextTurnSnapshots[0].emittedMessages.map((message) => message.role),
    ["assistant", "toolResult"],
  );
  assert.equal(textDeltas.join(""), "final answer");
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools runs consecutive Agent tool calls in parallel", async () => {
  const agentA = {
    type: "toolCall",
    id: "call-agent-a",
    name: "Agent",
    arguments: { id: "a", prompt: "Ask A" },
  };
  const agentB = {
    type: "toolCall",
    id: "call-agent-b",
    name: "Agent",
    arguments: { id: "b", prompt: "Ask B" },
  };
  resetFakeStreams(
    createAssistant([agentA, agentB], "toolUse"),
    createTextAssistant("final answer"),
  );
  let active = 0;
  let maxActive = 0;
  const statuses = [];
  const { params, executedToolCalls } = createBaseParams({
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [
        {
          name: "Agent",
          description: "Delegate",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    tools: [
      {
        name: "Agent",
        description: "Delegate",
        parameters: { type: "object", properties: {} },
      },
    ],
    async executeToolCall(toolCall) {
      executedToolCalls.push(toolCall);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return createToolResult(toolCall, `result:${toolCall.id}`);
    },
    onToolStatus(status) {
      if (status) statuses.push(status);
    },
    onBeforeNextTurn: async () => null,
  });

  const result = await runAssistantWithTools(params);

  assert.equal(maxActive, 2);
  assert.deepEqual(
    executedToolCalls.map((call) => call.id).sort(),
    ["call-agent-a", "call-agent-b"],
  );
  assert.ok(statuses.some((status) => /并行执行 2 个 Agent 调用/.test(status)));
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools propagates one SubagentScheduler across parallel Agent calls", async () => {
  const agentA = {
    type: "toolCall",
    id: "call-agent-a",
    name: "Agent",
    arguments: { agent_spec: "a1/a2/a3" },
  };
  const agentB = {
    type: "toolCall",
    id: "call-agent-b",
    name: "Agent",
    arguments: { agent_spec: "b1/b2/b3" },
  };
  resetFakeStreams(
    createAssistant([agentA, agentB], "toolUse"),
    createTextAssistant("final answer"),
  );

  const subagentScheduler = createSubagentScheduler({
    maxParallelSubagents: 2,
  });
  let activeSubagents = 0;
  let maxActiveSubagents = 0;
  const { params, executedToolCalls } = createBaseParams({
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [
        {
          name: "Agent",
          description: "Delegate",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    tools: [
      {
        name: "Agent",
        description: "Delegate",
        parameters: { type: "object", properties: {} },
      },
    ],
    subagentScheduler,
    async executeToolCall(toolCall, signal, context) {
      executedToolCalls.push(toolCall);
      assert.ok(context?.subagentScheduler);
      await Promise.all(
        [0, 1, 2].map((index) =>
          context.subagentScheduler.runSubagent(async () => {
            activeSubagents += 1;
            maxActiveSubagents = Math.max(maxActiveSubagents, activeSubagents);
            await new Promise((resolve) => setTimeout(resolve, 25 + index));
            activeSubagents -= 1;
          }, signal),
        ),
      );
      return createToolResult(toolCall, `result:${toolCall.id}`);
    },
    onBeforeNextTurn: async () => null,
  });

  const result = await runAssistantWithTools(params);

  assert.equal(maxActiveSubagents, 2);
  assert.deepEqual(
    executedToolCalls.map((call) => call.id).sort(),
    ["call-agent-a", "call-agent-b"],
  );
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools keeps consecutive Bash calls sequential", async () => {
  const bashA = {
    type: "toolCall",
    id: "call-bash-a",
    name: "Bash",
    arguments: { command: "echo a" },
  };
  const bashB = {
    type: "toolCall",
    id: "call-bash-b",
    name: "Bash",
    arguments: { command: "echo b" },
  };
  const bashC = {
    type: "toolCall",
    id: "call-bash-c",
    name: "Bash",
    arguments: { command: "echo c" },
  };
  resetFakeStreams(
    createAssistant([bashA, bashB, bashC], "toolUse"),
    createTextAssistant("final answer"),
  );

  let activeBash = 0;
  let maxActiveBash = 0;
  const statuses = [];
  const { params, executedToolCalls } = createBaseParams({
    context: {
      systemPrompt: "Base system prompt",
      messages: [{ role: "user", content: "Start", timestamp: 1 }],
      tools: [
        {
          name: "Bash",
          description: "Run shell",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    tools: [
      {
        name: "Bash",
        description: "Run shell",
        parameters: { type: "object", properties: {} },
      },
    ],
    subagentScheduler: createSubagentScheduler({
      maxParallelBash: 3,
    }),
    async executeToolCall(toolCall) {
      executedToolCalls.push(toolCall);
      activeBash += 1;
      maxActiveBash = Math.max(maxActiveBash, activeBash);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeBash -= 1;
      return createToolResult(toolCall, `result:${toolCall.id}`);
    },
    onToolStatus(status) {
      if (status) statuses.push(status);
    },
    onBeforeNextTurn: async () => null,
  });

  await runAssistantWithTools(params);

  assert.equal(maxActiveBash, 1);
  assert.deepEqual(
    executedToolCalls.map((call) => call.id),
    ["call-bash-a", "call-bash-b", "call-bash-c"],
  );
  assert.equal(statuses.some((status) => /并行执行 3 个 Bash 命令/.test(status)), false);
});

test("runAssistantWithTools applies turn context overrides without duplicating compacted messages", async () => {
  const toolCall = {
    type: "toolCall",
    id: "call-read",
    name: "Read",
    arguments: { path: "src/App.tsx" },
  };
  resetFakeStreams(
    createToolUseAssistant(toolCall),
    createTextAssistant("after compaction"),
  );
  const compactedContext = {
    systemPrompt: "Compacted system prompt",
    messages: [{ role: "user", content: "Resume from checkpoint", timestamp: 10 }],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
    ],
  };
  const { params } = createBaseParams({
    onBeforeNextTurn: async () => ({
      context: compactedContext,
      emittedMessages: [],
    }),
  });

  const result = await runAssistantWithTools(params);

  assert.equal(observedStreamContexts.length, 2);
  assert.equal(observedStreamContexts[1].systemPrompt, "Compacted system prompt");
  assert.deepEqual(
    observedStreamContexts[1].messages.map((message) => message.content),
    ["Resume from checkpoint"],
  );
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant"],
  );
  assert.deepEqual(
    result.messages.map((message) => message.role),
    ["user", "assistant"],
  );
});

test("runAssistantWithTools preserves seed tool-call recovery as a next-turn path", async () => {
  resetFakeStreams(
    createTextAssistant(`Before
<seed:tool_call>
  <function name="Read">
    <parameter name="path">src/App.tsx</parameter>
  </function>
</seed:tool_call>
After`),
    createTextAssistant("after recovered tool"),
  );
  const beforeNextTurnSnapshots = [];
  const { params, executedToolCalls } = createBaseParams({
    onBeforeNextTurn: async (snapshot) => {
      beforeNextTurnSnapshots.push(snapshot);
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].name, "Read");
  assert.deepEqual(executedToolCalls[0].arguments, { path: "src/App.tsx" });
  assert.equal(beforeNextTurnSnapshots.length, 1);
  assert.equal(beforeNextTurnSnapshots[0].assistant.stopReason, "toolUse");
  assert.equal(beforeNextTurnSnapshots[0].toolResults.length, 1);
  assert.deepEqual(
    beforeNextTurnSnapshots[0].emittedMessages.map((message) => message.role),
    ["assistant", "toolResult"],
  );
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools recovers DSML text tool calls as a next-turn path", async () => {
  const dsml = "\uFF5C\uFF5CDSML\uFF5C\uFF5C";
  resetFakeStreams(
    createTextAssistant(`Before
<${dsml}tool_calls>
  <${dsml}invoke name="Read">
    <${dsml}parameter name="path" string="true">src/App.tsx</${dsml}parameter>
  </${dsml}invoke>
</${dsml}tool_calls>
After`),
    createTextAssistant("after recovered DSML tool"),
  );
  const beforeNextTurnSnapshots = [];
  const { params, executedToolCalls } = createBaseParams({
    onBeforeNextTurn: async (snapshot) => {
      beforeNextTurnSnapshots.push(snapshot);
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].name, "Read");
  assert.deepEqual(executedToolCalls[0].arguments, { path: "src/App.tsx" });
  assert.equal(beforeNextTurnSnapshots.length, 1);
  assert.equal(beforeNextTurnSnapshots[0].assistant.stopReason, "toolUse");
  assert.equal(beforeNextTurnSnapshots[0].toolResults.length, 1);
  const recoveredAssistantText = result.emittedMessages[0].content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.equal(recoveredAssistantText.includes("DSML"), false);
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools bridges recovered DSML provider web_search without a local executor", async () => {
  const dsml = "\uFF5C\uFF5CDSML\uFF5C\uFF5C";
  resetFakeStreams(
    createTextAssistant(`Searching again
<${dsml}tool_calls>
  <${dsml}invoke name="web_search">
    <${dsml}parameter name="query" string="true">Deno Deploy alternatives temporary domain</${dsml}parameter>
  </${dsml}invoke>
</${dsml}tool_calls>`),
    createTextAssistant("final answer"),
  );
  const beforeNextTurnSnapshots = [];
  const toolCalls = [];
  const { params, executedToolCalls } = createBaseParams({
    nativeWebSearch: true,
    onToolCall: (toolCall) => {
      toolCalls.push(toolCall);
    },
    onBeforeNextTurn: async (snapshot) => {
      beforeNextTurnSnapshots.push(snapshot);
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(executedToolCalls.length, 0);
  assert.deepEqual(toolCalls.map((call) => call.name), ["web_search"]);
  assert.equal(beforeNextTurnSnapshots.length, 1);
  assert.equal(beforeNextTurnSnapshots[0].toolResults[0].isError, false);
  assert.match(
    beforeNextTurnSnapshots[0].toolResults[0].content[0].text,
    /provider-native web search request/,
  );
  assert.deepEqual(
    result.emittedMessages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
});

test("runAssistantWithTools does not run next-turn overrides for length/error/aborted terminal reasons", async () => {
  for (const stopReason of ["length", "error", "aborted"]) {
    resetFakeStreams(
      createTextAssistant(
        stopReason === "length" ? "truncated" : "",
        stopReason,
        stopReason === "error"
          ? { errorMessage: "provider failed" }
          : stopReason === "aborted"
            ? { errorMessage: "Request aborted" }
            : {},
      ),
    );
    let beforeNextTurnCalls = 0;
    const { params } = createBaseParams({
      onBeforeNextTurn: async () => {
        beforeNextTurnCalls += 1;
        return null;
      },
    });

    if (stopReason === "length") {
      const result = await runAssistantWithTools(params);
      assert.equal(result.assistant.stopReason, "length");
    } else {
      await assert.rejects(
        () => runAssistantWithTools(params),
        stopReason === "error" ? /provider failed/ : /Request aborted/,
      );
    }

    assert.equal(beforeNextTurnCalls, 0, `${stopReason} must not schedule onBeforeNextTurn`);
  }
});

test("runAssistantWithTools ignores malformed toolUse turns that have no tool results", async () => {
  resetFakeStreams(createTextAssistant("", "toolUse"));
  let beforeNextTurnCalls = 0;
  const { params } = createBaseParams({
    onBeforeNextTurn: async () => {
      beforeNextTurnCalls += 1;
      return null;
    },
  });

  const result = await runAssistantWithTools(params);

  assert.equal(beforeNextTurnCalls, 0);
  assert.equal(result.assistant.stopReason, "toolUse");
});
