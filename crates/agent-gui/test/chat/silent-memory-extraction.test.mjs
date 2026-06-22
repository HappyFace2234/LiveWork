import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function rootPath(...segments) {
  return path.join(
    path.resolve(fileURLToPath(new URL("../..", import.meta.url))),
    ...segments,
  );
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function textFromAssistant(message) {
  return (message.content ?? [])
    .map((block) => (block?.type === "text" ? block.text : ""))
    .join("");
}

function createAssistant(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "mock-provider",
    model: "mock-model",
    api: "mock-api",
    stopReason: "stop",
    usage: { totalTokens: 7 },
    timestamp: Date.now(),
  };
}

function createUser(text) {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  };
}

test("tool call delta flush uses a timer fallback when animation frames are paused", async () => {
  const loader = createTsModuleLoader();
  const { scheduleToolCallDeltaFlush } = loader.loadModule(
    "src/pages/chat/turns/runAgentConversationTurn.ts",
  );
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalDocument = globalThis.document;
  const cancelledFrames = [];
  let requestedFrame = false;
  let flushed = false;

  try {
    delete globalThis.document;
    globalThis.requestAnimationFrame = () => {
      requestedFrame = true;
      return 42;
    };
    globalThis.cancelAnimationFrame = (frameId) => {
      cancelledFrames.push(frameId);
    };

    scheduleToolCallDeltaFlush(() => {
      flushed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 90));

    assert.equal(requestedFrame, true);
    assert.equal(flushed, true);
    assert.deepEqual(cancelledFrames, [42]);
  } finally {
    if (originalRequestAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
    if (originalCancelAnimationFrame === undefined) {
      delete globalThis.cancelAnimationFrame;
    } else {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
  }
});

test("live transcript flush uses a timer fallback when animation frames are paused", async () => {
  const loader = createTsModuleLoader();
  const { scheduleLiveTranscriptFlush } = loader.loadModule(
    "src/pages/chat/hooks/useLiveTranscriptController.ts",
  );
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalDocument = globalThis.document;
  const cancelledFrames = [];
  let requestedFrame = false;
  let flushed = false;

  try {
    delete globalThis.document;
    globalThis.requestAnimationFrame = () => {
      requestedFrame = true;
      return 77;
    };
    globalThis.cancelAnimationFrame = (frameId) => {
      cancelledFrames.push(frameId);
    };

    scheduleLiveTranscriptFlush(() => {
      flushed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 130));

    assert.equal(requestedFrame, true);
    assert.equal(flushed, true);
    assert.deepEqual(cancelledFrames, [77]);
  } finally {
    if (originalRequestAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
    if (originalCancelAnimationFrame === undefined) {
      delete globalThis.cancelAnimationFrame;
    } else {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
  }
});

function validSilentMemoryPlanText() {
  return [
    "```json silent-memory-block-1-identify",
    '{ "items": [ { "fact": "用户偏好陕西腔", "quote": "以后请用陕西腔", "type": "feedback", "has_signal_word": true } ] }',
    "```",
    "```json silent-memory-block-2-match",
    '{ "items": [ { "fact_index": 0, "decision": "NEW", "slug": "user-dialect", "reason": "new preference" } ] }',
    "```",
    "```json silent-memory-block-3-plan",
    '{ "items": [ { "action": "write", "slug": "user-dialect", "scope": "global", "type": "feedback", "description": "用户偏好陕西腔交流", "body": "用户希望以后使用陕西腔交流。", "confidence": "high", "source_quote": "以后请用陕西腔", "reasoning": "explicit signal", "supersedes": null, "conflicts_with": null, "override_reject": null } ] }',
    "```",
    "```text silent-memory-block-4-emit",
    "记忆整理完成。",
    "```",
  ].join("\n");
}

function validSilentMemoryNoopText() {
  return [
    "```json silent-memory-block-1-identify",
    '{ "items": [] }',
    "```",
    "```json silent-memory-block-2-match",
    '{ "items": [] }',
    "```",
    "```json silent-memory-block-3-plan",
    '{ "items": [] }',
    "```",
    "```text silent-memory-block-4-emit",
    "本轮无需更新记忆。",
    "```",
  ].join("\n");
}

function validSilentMemoryAcceptPlanText() {
  return [
    "```json silent-memory-block-1-identify",
    '{ "items": [ { "fact": "用户确认专业信息", "quote": "对", "type": "user", "has_signal_word": false } ] }',
    "```",
    "```json silent-memory-block-2-match",
    '{ "items": [ { "fact_index": 0, "decision": "ACCEPT", "slug": "user-major", "reason": "confirmed unreviewed memory" } ] }',
    "```",
    "```json silent-memory-block-3-plan",
    '{ "items": [ { "action": "accept", "slug": "user-major", "scope": "global" } ] }',
    "```",
    "```text silent-memory-block-4-emit",
    "记忆整理完成。",
    "```",
  ].join("\n");
}

test("silent memory extraction builds a hidden MemoryManager-only request", async () => {
  let capturedRun = null;
  let capturedMemoryToolParams = null;
  const memoryTools = [{ name: "MemoryManager", parameters: {}, description: "memory" }];
  const executeToolCall = async () => ({
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "MemoryManager",
    content: [{ type: "text", text: "ok" }],
    details: {},
    isError: false,
    timestamp: Date.now(),
  });
  const loader = createTsModuleLoader({
    mocks: {
      [rootPath("src/lib/chat/runner/agentRunner.ts")]: {
        async runAssistantWithTools(params) {
          capturedRun = params;
          return {
            assistant: createAssistant("NO_MEMORY_UPDATES"),
            messages: params.context.messages,
            emittedMessages: [],
          };
        },
      },
      [rootPath("src/lib/memory/api.ts")]: {
        async memoryTodayLocalDate() {
          return "2026-05-14";
        },
        async memoryList() {
          return { entries: [], truncated: false, quota: { used: 0, limit: 500 } };
        },
        async memoryRecentRejections() {
          return { entries: [] };
        },
      },
      [rootPath("src/lib/tools/memoryTools.ts")]: {
        createMemoryTools(params) {
          capturedMemoryToolParams = params;
          return {
            tools: memoryTools,
            executeToolCall,
          };
        },
      },
    },
  });
  const { runSilentMemoryExtraction } = loader.loadModule(
    "src/pages/chat/memory/silentMemoryExtraction.ts",
  );
  const visibleMessages = [
    createUser("请记住：以后默认用陕西腔跟我交流。"),
    createAssistant("好，我会记住。"),
  ];
  const baseContext = {
    systemPrompt: "base system",
    messages: visibleMessages.slice(),
    tools: [{ name: "Read" }],
  };

  const result = await runSilentMemoryExtraction({
    providerId: "openai",
    model: "gpt-test",
    runtime: {
      baseUrl: "https://example.test",
      apiKey: "test-key",
    },
    sessionId: "session-1",
    conversationId: "conversation-1",
    workdir: "/workspace",
    buildContext: (tools) => ({
      ...baseContext,
      tools,
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.emittedMessages, []);
  assert.deepEqual(capturedMemoryToolParams, {
    workdir: "/workspace",
    mode: "ro",
    actor: "extractor",
    conversationId: "conversation-1",
    model: "gpt-test",
  });
  assert.equal(capturedRun.workdir, "/workspace");
  assert.equal(capturedRun.allowEmptyWorkdir, true);
  assert.equal(capturedRun.tools, memoryTools);
  assert.equal(capturedRun.executeToolCall, executeToolCall);
  assert.match(capturedRun.sessionId, /^session-1:memory:conversation-1:/);
  assert.match(capturedRun.context.systemPrompt, /base system/);
  assert.match(capturedRun.context.systemPrompt, /Hidden Post-Turn Memory Extraction/);
  assert.equal(capturedRun.context.tools, memoryTools);
  assert.equal(capturedRun.context.messages.length, visibleMessages.length + 1);
  assert.deepEqual(capturedRun.context.messages.slice(0, -1), visibleMessages);
  const hiddenPrompt = capturedRun.context.messages.at(-1);
  assert.equal(hiddenPrompt.role, "user");
  assert.match(hiddenPrompt.content, /Silently extract durable memory/);
  assert.match(hiddenPrompt.content, /daily-2026-05-14/);
  assert.match(hiddenPrompt.content, /Never prefix a slug with the user's current name/);
  assert.match(hiddenPrompt.content, /user-communication-style/);
  assert.match(hiddenPrompt.content, /Descriptions are visible in Settings/);
  assert.match(hiddenPrompt.content, /Daily titles are date-based/);
  assert.match(hiddenPrompt.content, /记忆整理完成/);
  assert.match(hiddenPrompt.content, /本轮无需更新记忆/);
  assert.deepEqual(baseContext.messages, visibleMessages);
});

test("silent memory extraction does not skip short confirmations for unreviewed memory", async () => {
  let capturedRun = null;
  const loader = createTsModuleLoader({
    mocks: {
      [rootPath("src/lib/chat/runner/agentRunner.ts")]: {
        async runAssistantWithTools(params) {
          capturedRun = params;
          const assistant = createAssistant(validSilentMemoryNoopText());
          return {
            assistant,
            messages: [...params.context.messages, assistant],
            emittedMessages: [assistant],
          };
        },
      },
      [rootPath("src/lib/memory/api.ts")]: {
        async memoryTodayLocalDate() {
          return "2026-05-14";
        },
        async memoryList() {
          return {
            entries: [
              {
                slug: "user-major",
                scope: "global",
                workdirHash: "",
                memoryType: "user",
                description: "用户可能是计算机专业学生",
                headline: "",
                createdAt: 1,
                updatedAt: 2,
                appendCount: 0,
                archived: false,
                unreviewed: true,
                confidence: "low",
                fileSize: 1,
              },
            ],
            truncated: false,
            quota: { used: 1, limit: 500 },
          };
        },
        async memoryRecentRejections() {
          return { entries: [] };
        },
      },
      [rootPath("src/lib/tools/memoryTools.ts")]: {
        createMemoryTools() {
          return {
            tools: [{ name: "MemoryManager", parameters: {}, description: "memory" }],
            async executeToolCall() {
              throw new Error("noop test should not execute tools");
            },
          };
        },
      },
    },
  });
  const { runSilentMemoryExtraction } = loader.loadModule(
    "src/pages/chat/memory/silentMemoryExtraction.ts",
  );

  const result = await runSilentMemoryExtraction({
    providerId: "openai",
    model: "gpt-test",
    runtime: {
      baseUrl: "https://example.test",
      apiKey: "test-key",
    },
    sessionId: "session-1",
    conversationId: "conversation-short-confirmation",
    workdir: "/workspace",
    buildContext: (tools) => ({
      systemPrompt: "base system",
      messages: [
        createAssistant("你是不是计算机专业学生？"),
        createUser("是的"),
        createAssistant("了解。"),
      ],
      tools,
    }),
  });

  assert.equal(result.ok, true);
  assert.ok(capturedRun, "short confirmation should still reach the hidden LLM pass");
  const hiddenPrompt = capturedRun.context.messages.at(-1);
  assert.match(hiddenPrompt.content, /user-major/);
  assert.match(hiddenPrompt.content, /confidence=low/);
});

test("silent memory extraction applies a validated block-3 plan with extractor write tools", async () => {
  const createCalls = [];
  const executedToolCalls = [];
  const finalAssistant = createAssistant(validSilentMemoryPlanText());
  const loader = createTsModuleLoader({
    mocks: {
      [rootPath("src/lib/chat/runner/agentRunner.ts")]: {
        async runAssistantWithTools(params) {
          return {
            assistant: finalAssistant,
            messages: [...params.context.messages, finalAssistant],
            emittedMessages: [finalAssistant],
          };
        },
      },
      [rootPath("src/lib/memory/api.ts")]: {
        async memoryTodayLocalDate() {
          return "2026-05-14";
        },
        async memoryList() {
          return { entries: [], truncated: false, quota: { used: 0, limit: 500 } };
        },
        async memoryRecentRejections() {
          return { entries: [] };
        },
      },
      [rootPath("src/lib/tools/memoryTools.ts")]: {
        createMemoryTools(params) {
          createCalls.push(params);
          return {
            tools: [{ name: "MemoryManager", parameters: {}, description: "memory" }],
            async executeToolCall(toolCall) {
              executedToolCalls.push(toolCall);
              return {
                role: "toolResult",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: [{ type: "text", text: "Created memory global/user-dialect" }],
                details: { created: true, slug: "user-dialect" },
                isError: false,
                timestamp: Date.now(),
              };
            },
          };
        },
      },
    },
  });
  const { runSilentMemoryExtraction } = loader.loadModule(
    "src/pages/chat/memory/silentMemoryExtraction.ts",
  );

  const result = await runSilentMemoryExtraction({
    providerId: "openai",
    model: "gpt-test",
    runtime: {
      baseUrl: "https://example.test",
      apiKey: "test-key",
    },
    sessionId: "session-1",
    conversationId: "conversation-1",
    workdir: "/workspace",
    buildContext: (tools) => ({
      systemPrompt: "base system",
      messages: [createUser("以后请用陕西腔。"), createAssistant("没问题。")],
      tools,
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(createCalls[0].mode, "ro");
  assert.equal(createCalls[1].mode, "rw");
  assert.equal(createCalls[1].actor, "extractor");
  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].arguments.action, "write");
  assert.equal(executedToolCalls[0].arguments.slug, "user-dialect");
  assert.equal(executedToolCalls[0].arguments.scope, "global");
  assert.equal(executedToolCalls[0].arguments.type, "feedback");
  assert.ok(result.emittedMessages.length >= 3);
  const rendered = JSON.stringify(result.emittedMessages);
  assert.doesNotMatch(rendered, /silent-memory-block-1-identify/);
  assert.match(rendered, /记忆整理完成。/);
});

test("silent memory extraction applies accept plans for confirmed unreviewed memories", async () => {
  const createCalls = [];
  const executedToolCalls = [];
  const finalAssistant = createAssistant(validSilentMemoryAcceptPlanText());
  const loader = createTsModuleLoader({
    mocks: {
      [rootPath("src/lib/chat/runner/agentRunner.ts")]: {
        async runAssistantWithTools(params) {
          return {
            assistant: finalAssistant,
            messages: [...params.context.messages, finalAssistant],
            emittedMessages: [finalAssistant],
          };
        },
      },
      [rootPath("src/lib/memory/api.ts")]: {
        async memoryTodayLocalDate() {
          return "2026-05-14";
        },
        async memoryList() {
          return {
            entries: [
              {
                slug: "user-major",
                scope: "global",
                workdirHash: "",
                memoryType: "user",
                description: "用户可能是计算机专业学生",
                headline: "",
                createdAt: 1,
                updatedAt: 2,
                appendCount: 0,
                archived: false,
                unreviewed: true,
                confidence: "low",
                fileSize: 1,
              },
            ],
            truncated: false,
            quota: { used: 1, limit: 500 },
          };
        },
        async memoryRecentRejections() {
          return { entries: [] };
        },
      },
      [rootPath("src/lib/tools/memoryTools.ts")]: {
        createMemoryTools(params) {
          createCalls.push(params);
          return {
            tools: [{ name: "MemoryManager", parameters: {}, description: "memory" }],
            async executeToolCall(toolCall) {
              executedToolCalls.push(toolCall);
              return {
                role: "toolResult",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: [{ type: "text", text: "Updated memory global/user-major" }],
                details: { updated: true, slug: "user-major" },
                isError: false,
                timestamp: Date.now(),
              };
            },
          };
        },
      },
    },
  });
  const { runSilentMemoryExtraction } = loader.loadModule(
    "src/pages/chat/memory/silentMemoryExtraction.ts",
  );

  const result = await runSilentMemoryExtraction({
    providerId: "openai",
    model: "gpt-test",
    runtime: {
      baseUrl: "https://example.test",
      apiKey: "test-key",
    },
    sessionId: "session-1",
    conversationId: "conversation-1",
    workdir: "/workspace",
    buildContext: (tools) => ({
      systemPrompt: "base system",
      messages: [createUser("对"), createAssistant("已按这个信息继续。")],
      tools,
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(createCalls[0].mode, "ro");
  assert.equal(createCalls[1].mode, "rw");
  assert.equal(executedToolCalls.length, 1);
  assert.equal(executedToolCalls[0].arguments.action, "accept");
  assert.equal(executedToolCalls[0].arguments.slug, "user-major");
  assert.equal(executedToolCalls[0].arguments.scope, "global");
});

test("silent memory extraction forwards model reply and MemoryManager traces as visible events", async () => {
  const forwarded = [];
  const memoryToolCall = {
    type: "toolCall",
    id: "memory-tool-visible",
    name: "MemoryManager",
    arguments: {
      action: "write",
      slug: "user-dialect",
      scope: "global",
      type: "feedback",
    },
  };
  const memoryToolResult = {
    role: "toolResult",
    toolCallId: memoryToolCall.id,
    toolName: "MemoryManager",
    content: [{ type: "text", text: "Created memory global/user-dialect" }],
    details: { created: true, slug: "user-dialect" },
    isError: false,
    timestamp: Date.now(),
  };
  const memoryFinalAssistant = createAssistant("记忆整理完成。");

  const loader = createTsModuleLoader({
    mocks: {
      [rootPath("src/lib/chat/runner/agentRunner.ts")]: {
        async runAssistantWithTools(params) {
          params.onTurnStart(1);
          params.onToolCall(memoryToolCall, 1);
          params.onToolExecutionStart(memoryToolCall, 1);
          params.onToolResult(memoryToolCall, memoryToolResult, 1);
          params.onTurnStart(2);
          params.onTextDelta("记忆整理完成。", 2);
          params.onAssistantMessage(memoryFinalAssistant, 2);
          return {
            assistant: memoryFinalAssistant,
            messages: params.context.messages,
            emittedMessages: [memoryToolCall, memoryToolResult, memoryFinalAssistant],
          };
        },
      },
      [rootPath("src/lib/memory/api.ts")]: {
        async memoryTodayLocalDate() {
          return "2026-05-14";
        },
        async memoryList() {
          return { entries: [], truncated: false, quota: { used: 0, limit: 500 } };
        },
        async memoryRecentRejections() {
          return { entries: [] };
        },
      },
      [rootPath("src/lib/tools/memoryTools.ts")]: {
        createMemoryTools() {
          return {
            tools: [{ name: "MemoryManager", parameters: {}, description: "memory" }],
            executeToolCall: async () => memoryToolResult,
          };
        },
      },
    },
  });
  const { runSilentMemoryExtraction } = loader.loadModule(
    "src/pages/chat/memory/silentMemoryExtraction.ts",
  );

  await runSilentMemoryExtraction({
    providerId: "openai",
    model: "gpt-test",
    runtime: {
      baseUrl: "https://example.test",
      apiKey: "test-key",
    },
    sessionId: "session-1",
    conversationId: "conversation-1",
    workdir: "/workspace",
    buildContext: (tools) => ({
      systemPrompt: "base system",
      messages: [
        createUser("以后请用陕西腔。"),
        createAssistant("没问题。"),
      ],
      tools,
    }),
    visibleEvents: {
      roundOffset: 10,
      onTurnStart: (round) => forwarded.push({ type: "turn", round }),
      onToolCall: (toolCall, round) =>
        forwarded.push({ type: "tool_call", id: toolCall.id, round }),
      onToolExecutionStart: (toolCall, round) =>
        forwarded.push({ type: "tool_start", id: toolCall.id, round }),
      onToolResult: (toolCall, toolResult, round) =>
        forwarded.push({
          type: "tool_result",
          id: toolCall.id,
          text: toolResult.content[0]?.text,
          round,
        }),
      onTextDelta: (delta, round) =>
        forwarded.push({ type: "token", text: delta, round }),
      onAssistantMessage: (assistant, round) =>
        forwarded.push({
          type: "assistant",
          text: textFromAssistant(assistant),
          round,
        }),
    },
  });

  assert.deepEqual(forwarded, [
    { type: "turn", round: 11 },
    { type: "tool_call", id: "memory-tool-visible", round: 11 },
    { type: "tool_start", id: "memory-tool-visible", round: 11 },
    {
      type: "tool_result",
      id: "memory-tool-visible",
      text: "Created memory global/user-dialect",
      round: 11,
    },
    { type: "turn", round: 12 },
    { type: "token", text: "记忆整理完成。", round: 12 },
    { type: "assistant", text: "记忆整理完成。", round: 12 },
  ]);
  assert.doesNotMatch(JSON.stringify(forwarded), /Silently extract durable memory/);
});

test("silent memory extraction does not expose four-block protocol text through visible events", async () => {
  const forwarded = [];
  const finalAssistant = createAssistant(validSilentMemoryPlanText());
  const loader = createTsModuleLoader({
    mocks: {
      [rootPath("src/lib/chat/runner/agentRunner.ts")]: {
        async runAssistantWithTools(params) {
          params.onTurnStart(1);
          params.onTextDelta(validSilentMemoryPlanText(), 1);
          params.onAssistantMessage(finalAssistant, 1);
          return {
            assistant: finalAssistant,
            messages: [...params.context.messages, finalAssistant],
            emittedMessages: [finalAssistant],
          };
        },
      },
      [rootPath("src/lib/memory/api.ts")]: {
        async memoryTodayLocalDate() {
          return "2026-05-14";
        },
        async memoryList() {
          return { entries: [], truncated: false, quota: { used: 0, limit: 500 } };
        },
        async memoryRecentRejections() {
          return { entries: [] };
        },
      },
      [rootPath("src/lib/tools/memoryTools.ts")]: {
        createMemoryTools() {
          return {
            tools: [{ name: "MemoryManager", parameters: {}, description: "memory" }],
            async executeToolCall(toolCall) {
              return {
                role: "toolResult",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: [{ type: "text", text: "Created memory global/user-dialect" }],
                details: { created: true, slug: "user-dialect" },
                isError: false,
                timestamp: Date.now(),
              };
            },
          };
        },
      },
    },
  });
  const { runSilentMemoryExtraction } = loader.loadModule(
    "src/pages/chat/memory/silentMemoryExtraction.ts",
  );

  const result = await runSilentMemoryExtraction({
    providerId: "openai",
    model: "gpt-test",
    runtime: {
      baseUrl: "https://example.test",
      apiKey: "test-key",
    },
    sessionId: "session-1",
    conversationId: "conversation-1",
    workdir: "/workspace",
    buildContext: (tools) => ({
      systemPrompt: "base system",
      messages: [createUser("以后请用陕西腔。"), createAssistant("没问题。")],
      tools,
    }),
    visibleEvents: {
      onTurnStart: (round) => forwarded.push({ type: "turn", round }),
      onTextDelta: (delta, round) => forwarded.push({ type: "token", text: delta, round }),
      onAssistantMessage: (assistant, round) =>
        forwarded.push({ type: "assistant", text: textFromAssistant(assistant), round }),
      onToolCall: (toolCall, round) =>
        forwarded.push({ type: "tool_call", id: toolCall.id, round }),
      onToolResult: (toolCall, toolResult, round) =>
        forwarded.push({ type: "tool_result", id: toolCall.id, round, isError: toolResult.isError }),
    },
  });

  const visibleJson = JSON.stringify(forwarded);
  const emittedJson = JSON.stringify(result.emittedMessages);
  assert.doesNotMatch(visibleJson, /silent-memory-block-1-identify/);
  assert.doesNotMatch(emittedJson, /silent-memory-block-1-identify/);
  assert.match(visibleJson, /记忆整理完成。/);
  assert.match(emittedJson, /记忆整理完成。/);
});

test("agent mode runs silent extraction hidden in background without delaying done", async () => {
  const memoryStarted = createDeferred();
  const memoryRelease = createDeferred();
  const events = [];
  const persisted = [];
  const runtimeEntries = [];
  let capturedVisibleEvents = "unset";
  const memoryToolCall = {
    type: "toolCall",
    id: "memory-tool-agent",
    name: "MemoryManager",
    arguments: {
      action: "update",
      slug: "daily-2026-05-14",
      mode: "append",
    },
  };
  const memoryToolAssistant = {
    ...createAssistant(""),
    content: [memoryToolCall],
    stopReason: "toolUse",
  };
  const memoryToolResult = {
    role: "toolResult",
    toolCallId: memoryToolCall.id,
    toolName: "MemoryManager",
    content: [{ type: "text", text: "Updated memory global/daily-2026-05-14" }],
    details: { updated: true, slug: "daily-2026-05-14" },
    isError: false,
    timestamp: Date.now(),
  };
  const memoryFinalAssistant = createAssistant("记忆整理完成。");

  const loader = createTsModuleLoader({
    mocks: {
      [rootPath("src/lib/providers/llm.ts")]: {
        assistantMessageToText: textFromAssistant,
      },
      [rootPath("src/lib/chat/runner/agentRunner.ts")]: {
        async runAssistantWithTools(params) {
          params.onTurnStart(1);
          params.onTextDelta("visible agent answer", 1);
          const assistant = createAssistant("visible agent answer");
          params.onAssistantMessage(assistant, 1);
          return {
            assistant,
            messages: [...params.context.messages, assistant],
            emittedMessages: [assistant],
          };
        },
      },
      [rootPath("src/lib/chat/compaction/contextCompaction.ts")]: {
        noteCompactionRound() {},
        shouldProtectionCompactConversation() {
          return { shouldCompact: false, reason: "within-budget" };
        },
      },
      [rootPath("src/lib/chat/conversation/chatAbort.ts")]: {
        isAbortedAssistantMessage() {
          return false;
        },
      },
      [rootPath("src/lib/chat/subagent/subagentHistory.ts")]: {
        async listSubagentIdentities() {
          return [];
        },
        async listSubagentRuns() {
          return [];
        },
      },
      [rootPath("src/lib/chat/subagent/subagentReminders.ts")]: {
        buildExistingSubagentsReminder() {
          return "";
        },
      },
      [rootPath("src/lib/chat/subagent/subagentScheduler.ts")]: {
        createSubagentScheduler() {
          return {};
        },
      },
      [rootPath("src/lib/tools/builtinRegistry.ts")]: {
        async buildBuiltinToolRegistry() {
          return {
            tools: [],
            executeToolCall: async () => memoryToolResult,
          };
        },
      },
      [rootPath("src/lib/tools/fileToolState.ts")]: {
        createFileToolState() {
          return {};
        },
      },
      [rootPath("src/pages/chat/memory/silentMemoryExtraction.ts")]: {
        recordSilentMemoryTurnBoundary() {},
        async runSilentMemoryExtraction(params) {
          capturedVisibleEvents = params.visibleEvents;
          memoryStarted.resolve();
          await memoryRelease.promise;
          return {
            ok: true,
            emittedMessages: [
              memoryToolAssistant,
              memoryToolResult,
              memoryFinalAssistant,
            ],
          };
        },
      },
    },
  });
  const { createConversationStateFromContext, buildRequestContext } = loader.loadModule(
    "src/lib/chat/conversation/conversationState.ts",
  );
  const { runAgentConversationTurn } = loader.loadModule(
    "src/pages/chat/turns/runAgentConversationTurn.ts",
  );

  let state = createConversationStateFromContext({
    systemPrompt: "base system",
    messages: [createUser("请实现记忆抽取")],
  });
  const requestController = new AbortController();
  const gatewayBridgeEvents = {
    queueToken(text, extra) {
      events.push({ type: "token", text, ...(extra ?? {}) });
    },
    queueEvent(event) {
      events.push(event);
    },
    queueToolStatus(status) {
      events.push({ type: "tool_status", status });
    },
    hasForwardedText() {
      return events.some((event) => event.type === "token" && event.text);
    },
    close() {
      events.push({ type: "closed" });
    },
  };
  const hookLifecycle = {
    startAgent() {},
    startTurn() {},
    messageUpdated() {},
    ensureMessageEnded() {},
    assistantMessageCompleted() {},
    toolExecutionStarted() {},
    toolResultReceived() {},
    endTurn() {},
    endAgent() {},
  };
  const buildPreparedContext = (nextState, tools) => ({
    ...buildRequestContext(nextState),
    tools,
  });
  const turnPromise = runAgentConversationTurn({
    providerId: "openai",
    model: "gpt-test",
    runtime: {
      baseUrl: "https://example.test",
      apiKey: "test-key",
    },
    runtimeModel: {
      api: "mock-api",
      provider: "mock-provider",
      id: "mock-model",
    },
    selectedModel: {
      customProviderId: "openai",
      model: "gpt-test",
    },
    effectiveWorkdir: "/workspace",
    effectiveSkillsEnabled: false,
    showSilentMemoryExtraction: false,
    agentTemplates: [],
    selectedSystemToolIds: [],
    mcpSettings: { servers: [] },
    enabledMcpServerIds: [],
    selectableMcpServers: [],
    sessionId: "session-1",
    conversationId: "conversation-1",
    conversationCwd: "/workspace",
    fallbackTitle: "Fallback",
    createdAt: 1,
    titlePromise: null,
    transcriptStore: {},
    gatewayBridgeEvents,
    hookLifecycle,
    conversationThrottleState: {
      lastCompactionTime: 0,
      roundsSinceLastCompaction: 3,
      recentCompactionCount: 0,
      totalSessionCompactions: 0,
      consecutiveCompactions: 0,
    },
    conversationDebugLogger: {
      enabled: false,
      logRequest() {},
      logResponse() {},
      logResult() {},
      logError() {},
      flush: async () => {},
    },
    compactionDebugLogger: {
      enabled: false,
      logRequest() {},
      logResponse() {},
      logResult() {},
      logError() {},
      flush: async () => {},
    },
    getNextConversationState: () => state,
    applyConversationState: (next) => {
      state = next;
    },
    buildCompactionContext: (nextState, tools) => ({
      ...buildRequestContext(nextState),
      tools,
    }),
    buildPreparedContext,
    maybeApplyPreCompaction: async () => false,
    compactDuringRun: async () => null,
    getRequestController: () => requestController,
    renewRequestController: () => requestController,
    resetLiveTranscript() {},
    updateLiveRounds() {},
    batchLiveRoundsUpdate() {},
    updateToolStatus() {},
    updateGatewayBridgeToolStatus() {},
    isConversationVisible: () => true,
    commitVisibleAbortedConversation: () => false,
    updateConversationRuntimeEntry: (_conversationId, updater) => {
      const next = updater({ state });
      runtimeEntries.push(next);
      return next;
    },
    persistConversationWithHistorySync: async (params) => {
      persisted.push(params);
      return true;
    },
  });

  await memoryStarted.promise;
  assert.equal(capturedVisibleEvents, undefined);
  assert.equal(events.some((event) => event.type === "done"), true);
  assert.equal(events.some((event) => event.type === "tool_call"), false);
  assert.equal(events.some((event) => event.type === "tool_result"), false);
  assert.equal(
    events.some((event) => event.type === "token" && event.text === "记忆整理完成。"),
    false,
  );
  assert.equal(persisted.length, 1);
  assert.equal(runtimeEntries.length, 1);
  assert.equal(
    JSON.stringify(persisted[0].state.historyRenderItems).includes("MemoryManager"),
    false,
  );

  memoryRelease.resolve();
  await turnPromise;
});

test("agent dev mode shows silent extraction and delays done until extraction finishes", async () => {
  const memoryStarted = createDeferred();
  const memoryRelease = createDeferred();
  const events = [];
  const persisted = [];
  const runtimeEntries = [];
  let capturedVisibleEvents = null;
  const memoryToolCall = {
    type: "toolCall",
    id: "memory-tool-agent-dev",
    name: "MemoryManager",
    arguments: {
      action: "update",
      slug: "daily-2026-05-14",
      mode: "append",
    },
  };
  const memoryToolAssistant = {
    ...createAssistant(""),
    content: [memoryToolCall],
    stopReason: "toolUse",
  };
  const memoryToolResult = {
    role: "toolResult",
    toolCallId: memoryToolCall.id,
    toolName: "MemoryManager",
    content: [{ type: "text", text: "Updated memory global/daily-2026-05-14" }],
    details: { updated: true, slug: "daily-2026-05-14" },
    isError: false,
    timestamp: Date.now(),
  };
  const memoryFinalAssistant = createAssistant("记忆整理完成。");

  const loader = createTsModuleLoader({
    mocks: {
      [rootPath("src/lib/providers/llm.ts")]: {
        assistantMessageToText: textFromAssistant,
      },
      [rootPath("src/lib/chat/runner/agentRunner.ts")]: {
        async runAssistantWithTools(params) {
          params.onTurnStart(1);
          params.onTextDelta("visible agent answer", 1);
          const assistant = createAssistant("visible agent answer");
          params.onAssistantMessage(assistant, 1);
          return {
            assistant,
            messages: [...params.context.messages, assistant],
            emittedMessages: [assistant],
          };
        },
      },
      [rootPath("src/lib/chat/compaction/contextCompaction.ts")]: {
        noteCompactionRound() {},
        shouldProtectionCompactConversation() {
          return { shouldCompact: false, reason: "within-budget" };
        },
      },
      [rootPath("src/lib/chat/conversation/chatAbort.ts")]: {
        isAbortedAssistantMessage() {
          return false;
        },
      },
      [rootPath("src/lib/chat/subagent/subagentHistory.ts")]: {
        async listSubagentIdentities() {
          return [];
        },
        async listSubagentRuns() {
          return [];
        },
      },
      [rootPath("src/lib/chat/subagent/subagentReminders.ts")]: {
        buildExistingSubagentsReminder() {
          return "";
        },
      },
      [rootPath("src/lib/chat/subagent/subagentScheduler.ts")]: {
        createSubagentScheduler() {
          return {};
        },
      },
      [rootPath("src/lib/tools/builtinRegistry.ts")]: {
        async buildBuiltinToolRegistry() {
          return {
            tools: [],
            executeToolCall: async () => memoryToolResult,
          };
        },
      },
      [rootPath("src/lib/tools/fileToolState.ts")]: {
        createFileToolState() {
          return {};
        },
      },
      [rootPath("src/pages/chat/memory/silentMemoryExtraction.ts")]: {
        recordSilentMemoryTurnBoundary() {},
        async runSilentMemoryExtraction(params) {
          capturedVisibleEvents = params.visibleEvents;
          const firstMemoryRound = (params.visibleEvents?.roundOffset ?? 0) + 1;
          const finalMemoryRound = firstMemoryRound + 1;
          params.visibleEvents?.onTurnStart?.(firstMemoryRound);
          params.visibleEvents?.onToolCall?.(memoryToolCall, firstMemoryRound);
          params.visibleEvents?.onToolExecutionStart?.(
            memoryToolCall,
            firstMemoryRound,
          );
          params.visibleEvents?.onToolResult?.(
            memoryToolCall,
            memoryToolResult,
            firstMemoryRound,
          );
          params.visibleEvents?.onTurnStart?.(finalMemoryRound);
          params.visibleEvents?.onTextDelta?.("记忆整理完成。", finalMemoryRound);
          params.visibleEvents?.onAssistantMessage?.(
            memoryFinalAssistant,
            finalMemoryRound,
          );
          memoryStarted.resolve();
          await memoryRelease.promise;
          return {
            ok: true,
            emittedMessages: [
              memoryToolAssistant,
              memoryToolResult,
              memoryFinalAssistant,
            ],
          };
        },
      },
    },
  });
  const { createConversationStateFromContext, buildRequestContext } = loader.loadModule(
    "src/lib/chat/conversation/conversationState.ts",
  );
  const { runAgentConversationTurn } = loader.loadModule(
    "src/pages/chat/turns/runAgentConversationTurn.ts",
  );

  let state = createConversationStateFromContext({
    systemPrompt: "base system",
    messages: [createUser("请实现记忆抽取")],
  });
  const requestController = new AbortController();
  const gatewayBridgeEvents = {
    queueToken(text, extra) {
      events.push({ type: "token", text, ...(extra ?? {}) });
    },
    queueEvent(event) {
      events.push(event);
    },
    queueToolStatus(status) {
      events.push({ type: "tool_status", status });
    },
    hasForwardedText() {
      return events.some((event) => event.type === "token" && event.text);
    },
    close() {
      events.push({ type: "closed" });
    },
  };
  const hookLifecycle = {
    startAgent() {},
    startTurn() {},
    messageUpdated() {},
    ensureMessageEnded() {},
    assistantMessageCompleted() {},
    toolExecutionStarted() {},
    toolResultReceived() {},
    endTurn() {},
    endAgent() {},
  };
  const buildPreparedContext = (nextState, tools) => ({
    ...buildRequestContext(nextState),
    tools,
  });
  const turnPromise = runAgentConversationTurn({
    providerId: "openai",
    model: "gpt-test",
    runtime: {
      baseUrl: "https://example.test",
      apiKey: "test-key",
    },
    runtimeModel: {
      api: "mock-api",
      provider: "mock-provider",
      id: "mock-model",
    },
    selectedModel: {
      customProviderId: "openai",
      model: "gpt-test",
    },
    effectiveWorkdir: "/workspace",
    effectiveSkillsEnabled: false,
    showSilentMemoryExtraction: true,
    agentTemplates: [],
    selectedSystemToolIds: [],
    mcpSettings: { servers: [] },
    enabledMcpServerIds: [],
    selectableMcpServers: [],
    sessionId: "session-1",
    conversationId: "conversation-1",
    conversationCwd: "/workspace",
    fallbackTitle: "Fallback",
    createdAt: 1,
    titlePromise: null,
    transcriptStore: {},
    gatewayBridgeEvents,
    hookLifecycle,
    conversationThrottleState: {
      lastCompactionTime: 0,
      roundsSinceLastCompaction: 3,
      recentCompactionCount: 0,
      totalSessionCompactions: 0,
      consecutiveCompactions: 0,
    },
    conversationDebugLogger: {
      enabled: false,
      logRequest() {},
      logResponse() {},
      logResult() {},
      logError() {},
      flush: async () => {},
    },
    compactionDebugLogger: {
      enabled: false,
      logRequest() {},
      logResponse() {},
      logResult() {},
      logError() {},
      flush: async () => {},
    },
    getNextConversationState: () => state,
    applyConversationState: (next) => {
      state = next;
    },
    buildCompactionContext: (nextState, tools) => ({
      ...buildRequestContext(nextState),
      tools,
    }),
    buildPreparedContext,
    maybeApplyPreCompaction: async () => false,
    compactDuringRun: async () => null,
    getRequestController: () => requestController,
    renewRequestController: () => requestController,
    resetLiveTranscript() {},
    updateLiveRounds() {},
    batchLiveRoundsUpdate() {},
    updateToolStatus() {},
    updateGatewayBridgeToolStatus() {},
    isConversationVisible: () => true,
    commitVisibleAbortedConversation: () => false,
    updateConversationRuntimeEntry: (_conversationId, updater) => {
      const next = updater({ state });
      runtimeEntries.push(next);
      return next;
    },
    persistConversationWithHistorySync: async (params) => {
      persisted.push(params);
      return true;
    },
  });

  await memoryStarted.promise;
  assert.ok(capturedVisibleEvents);
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.equal(persisted.length, 0);
  assert.equal(runtimeEntries.length, 0);
  assert.equal(events.some((event) => event.type === "tool_call"), true);
  assert.equal(events.some((event) => event.type === "tool_result"), true);
  assert.equal(
    events.some((event) => event.type === "token" && event.text === "记忆整理完成。"),
    true,
  );

  memoryRelease.resolve();
  await turnPromise;

  assert.equal(events.some((event) => event.type === "done"), true);
  assert.equal(persisted.length, 1);
  assert.equal(runtimeEntries.length, 1);
  const doneIndex = events.findIndex((event) => event.type === "done");
  const memoryTokenIndex = events.findIndex(
    (event) => event.type === "token" && event.text === "记忆整理完成。",
  );
  assert.ok(doneIndex > memoryTokenIndex);

  const storedMessages =
    persisted[0].state.segments[persisted[0].state.activeSegmentIndex].messages;
  assert.equal(storedMessages.length, 2);
  assert.doesNotMatch(JSON.stringify(storedMessages), /MemoryManager/);
  assert.doesNotMatch(JSON.stringify(storedMessages), /记忆整理完成。/);

  const requestContext = buildRequestContext(persisted[0].state);
  assert.equal(requestContext.messages.length, 2);
  assert.doesNotMatch(JSON.stringify(requestContext.messages), /MemoryManager/);
  assert.doesNotMatch(JSON.stringify(requestContext.messages), /记忆整理完成。/);

  const renderJson = JSON.stringify(persisted[0].state.historyRenderItems);
  assert.match(renderJson, /MemoryManager/);
  assert.match(renderJson, /记忆整理完成。/);
});

test("text mode runs silent extraction hidden in background without delaying done", async () => {
  const memoryStarted = createDeferred();
  const memoryRelease = createDeferred();
  const events = [];
  const persisted = [];
  const runtimeEntries = [];
  let draftText = "";
  let capturedVisibleEvents = "unset";
  const memoryToolCall = {
    type: "toolCall",
    id: "memory-tool-1",
    name: "MemoryManager",
    arguments: {
      action: "update",
      slug: "daily-2026-05-14",
      mode: "append",
    },
  };
  const memoryToolAssistant = {
    ...createAssistant(""),
    content: [memoryToolCall],
    stopReason: "toolUse",
  };
  const memoryToolResult = {
    role: "toolResult",
    toolCallId: memoryToolCall.id,
    toolName: "MemoryManager",
    content: [{ type: "text", text: "Updated memory global/daily-2026-05-14" }],
    details: { updated: true, slug: "daily-2026-05-14" },
    isError: false,
    timestamp: Date.now(),
  };
  const memoryFinalAssistant = createAssistant("记忆整理完成。");

  const loader = createTsModuleLoader({
    mocks: {
      [rootPath("src/lib/providers/llm.ts")]: {
        assistantMessageToText: textFromAssistant,
        async streamAssistantMessage(params) {
          params.onTextDelta("visible answer");
          return createAssistant("visible answer");
        },
      },
      [rootPath("src/lib/chat/compaction/contextCompaction.ts")]: {
        noteCompactionRound() {},
        shouldProtectionCompactConversation() {
          return { shouldCompact: false, reason: "within-budget" };
        },
      },
      [rootPath("src/pages/chat/memory/silentMemoryExtraction.ts")]: {
        recordSilentMemoryTurnBoundary() {},
        async runSilentMemoryExtraction(params) {
          capturedVisibleEvents = params.visibleEvents;
          memoryStarted.resolve();
          await memoryRelease.promise;
          return {
            ok: true,
            emittedMessages: [
              memoryToolAssistant,
              memoryToolResult,
              memoryFinalAssistant,
            ],
          };
        },
      },
    },
  });
  const { createConversationStateFromContext, buildRequestContext } = loader.loadModule(
    "src/lib/chat/conversation/conversationState.ts",
  );
  const { runTextConversationTurn } = loader.loadModule(
    "src/pages/chat/turns/runTextConversationTurn.ts",
  );

  let state = createConversationStateFromContext({
    systemPrompt: "base system",
    messages: [createUser("请实现记忆抽取")],
  });
  const requestController = new AbortController();
  const gatewayBridgeEvents = {
    queueToken(text, extra) {
      events.push({ type: "token", text, ...(extra ?? {}) });
    },
    queueEvent(event) {
      events.push(event);
    },
    hasForwardedText() {
      return events.some((event) => event.type === "token" && event.text);
    },
    close() {
      events.push({ type: "closed" });
    },
  };
  const hookLifecycle = {
    startAgent() {},
    startTurn() {},
    messageUpdated() {},
    ensureMessageEnded() {},
    endTurn() {},
    endAgent() {},
  };
  const buildPreparedContext = (nextState, tools) => ({
    ...buildRequestContext(nextState),
    tools,
  });
  const turnPromise = runTextConversationTurn({
    providerId: "openai",
    model: "gpt-test",
    runtime: {
      baseUrl: "https://example.test",
      apiKey: "test-key",
    },
    runtimeModel: {
      api: "mock-api",
      provider: "mock-provider",
      id: "mock-model",
    },
    sessionId: "session-1",
    conversationId: "conversation-1",
    conversationCwd: "/workspace",
    fallbackTitle: "Fallback",
    createdAt: 1,
    titlePromise: null,
    transcriptStore: {},
    gatewayBridgeEvents,
    hookLifecycle,
    conversationThrottleState: {
      lastCompactionTime: 0,
      roundsSinceLastCompaction: 3,
      recentCompactionCount: 0,
      totalSessionCompactions: 0,
      consecutiveCompactions: 0,
    },
    conversationDebugLogger: {
      enabled: false,
      logRequest() {},
      logResponse() {},
      logResult() {},
      logError() {},
      flush: async () => {},
    },
    recoveryDebugLogger: {
      enabled: false,
      logRequest() {},
      logResponse() {},
      logResult() {},
      logError() {},
      flush: async () => {},
    },
    compactionDebugLogger: {
      enabled: false,
      logRequest() {},
      logResponse() {},
      logResult() {},
      logError() {},
      flush: async () => {},
    },
    getNextConversationState: () => state,
    applyConversationState: (next) => {
      state = next;
    },
    buildCompactionContext: (nextState, tools) => ({
      ...buildRequestContext(nextState),
      tools,
    }),
    buildPreparedContext,
    maybeApplyPreCompaction: async () => false,
    compactDuringRun: async () => null,
    getRequestController: () => requestController,
    renewRequestController: () => requestController,
    resetLiveTranscript() {},
    appendDraftAssistantText(delta) {
      draftText += delta;
    },
    batchLiveRoundsUpdate() {},
    updateGatewayBridgeToolStatus() {},
    isConversationVisible: () => true,
    commitVisibleAbortedConversation: () => false,
    updateConversationRuntimeEntry: (_conversationId, updater) => {
      const next = updater({ state });
      runtimeEntries.push(next);
      return next;
    },
    persistConversationWithHistorySync: async (params) => {
      persisted.push(params);
      return true;
    },
  });

  await memoryStarted.promise;
  assert.equal(draftText, "visible answer");
  assert.equal(events[0].text, "visible answer");
  assert.equal(capturedVisibleEvents, undefined);
  assert.equal(events.some((event) => event.type === "tool_call"), false);
  assert.equal(events.some((event) => event.type === "tool_result"), false);
  assert.equal(
    events.some((event) => event.type === "token" && event.text === "记忆整理完成。"),
    false,
  );
  assert.equal(events.some((event) => event.type === "done"), true);
  assert.equal(persisted.length, 1);
  assert.equal(runtimeEntries.length, 1);

  memoryRelease.resolve();
  await turnPromise;

  const terminalToken = events.find(
    (event) => event.type === "token" && event.text === "" && event.stopReason === "stop",
  );
  assert.ok(terminalToken);
  assert.equal(events.some((event) => event.type === "done"), true);
  assert.equal(persisted.length, 1);
  assert.equal(runtimeEntries.length, 1);
  const storedMessages = persisted[0].state.segments[persisted[0].state.activeSegmentIndex].messages;
  assert.equal(storedMessages.length, 2);
  assert.equal(storedMessages[0].role, "user");
  assert.equal(storedMessages[1].role, "assistant");
  assert.doesNotMatch(JSON.stringify(storedMessages), /MemoryManager/);
  assert.doesNotMatch(JSON.stringify(storedMessages), /记忆整理完成。/);

  const requestContext = buildRequestContext(persisted[0].state);
  assert.equal(requestContext.messages.length, 2);
  assert.doesNotMatch(JSON.stringify(requestContext.messages), /MemoryManager/);
  assert.doesNotMatch(JSON.stringify(requestContext.messages), /记忆整理完成。/);

  const renderJson = JSON.stringify(persisted[0].state.historyRenderItems);
  assert.doesNotMatch(renderJson, /MemoryManager/);
  assert.doesNotMatch(renderJson, /记忆整理完成。/);
  assert.doesNotMatch(JSON.stringify(storedMessages), /Silently extract durable memory/);
});
