import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  clampOpenAIReasoningEffort,
  mapGeminiThinkingLevel,
  mapReasoningToAnthropicEffort,
  resolveAnthropicThinkingRuntime,
  resolveGeminiThinkingRuntime,
  supportsAdaptiveAnthropicThinking,
} = loader.loadModule("src/lib/providers/runtime/thinkingLevels.ts");

function createAnthropicModel(id, overrides = {}) {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    ...overrides,
  };
}

function createGoogleModel(id) {
  return {
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  };
}

test("anthropic: catalog compat.forceAdaptiveThinking wins over id heuristics", () => {
  const fable = createAnthropicModel("claude-fable-5", {
    compat: { forceAdaptiveThinking: true },
    thinkingLevelMap: { off: null, xhigh: "xhigh" },
  });
  assert.equal(supportsAdaptiveAnthropicThinking(fable), true);

  const optedOut = createAnthropicModel("claude-opus-4-6", {
    compat: { forceAdaptiveThinking: false },
  });
  assert.equal(supportsAdaptiveAnthropicThinking(optedOut), false);
});

test("anthropic: id heuristics cover 4.6+/5-family customs and reject dated 4.0 ids", () => {
  assert.equal(supportsAdaptiveAnthropicThinking(createAnthropicModel("claude-opus-4-7")), true);
  assert.equal(
    supportsAdaptiveAnthropicThinking(createAnthropicModel("claude-sonnet-4.6")),
    true,
  );
  assert.equal(supportsAdaptiveAnthropicThinking(createAnthropicModel("claude-sonnet-5")), true);
  assert.equal(
    supportsAdaptiveAnthropicThinking(createAnthropicModel("claude-fable-5-20260203")),
    true,
  );
  // 日期后缀不是小版本号：sonnet-4-20250514 是 Sonnet 4.0，必须走 budget 模式。
  assert.equal(
    supportsAdaptiveAnthropicThinking(createAnthropicModel("claude-sonnet-4-20250514")),
    false,
  );
  assert.equal(
    supportsAdaptiveAnthropicThinking(createAnthropicModel("claude-opus-4-5")),
    false,
  );
  assert.equal(
    supportsAdaptiveAnthropicThinking(createAnthropicModel("claude-3-5-sonnet-20241022")),
    false,
  );
});

test("anthropic: fable-5 resolves to adaptive mode with catalog-mapped xhigh effort", () => {
  const fable = createAnthropicModel("claude-fable-5", {
    compat: { forceAdaptiveThinking: true },
    thinkingLevelMap: { off: null, xhigh: "xhigh" },
  });
  const runtime = resolveAnthropicThinkingRuntime(fable, { reasoning: "xhigh" });
  assert.equal(runtime.mode, "adaptive");
  assert.equal(runtime.effort, "xhigh");
  assert.equal(runtime.thinkingEnabled, true);

  assert.equal(mapReasoningToAnthropicEffort("medium", fable), "medium");
  assert.equal(mapReasoningToAnthropicEffort("low", fable), "low");
});

test("anthropic: catalog thinkingLevelMap downgrade (opus-4-6 xhigh -> max) is honored", () => {
  const opus46 = createAnthropicModel("claude-opus-4-6", {
    compat: { forceAdaptiveThinking: true },
    thinkingLevelMap: { xhigh: "max" },
  });
  assert.equal(mapReasoningToAnthropicEffort("xhigh", opus46), "max");

  // 没有目录映射的自定义 4.6 id 走能力降级：xhigh -> max。
  const custom46 = createAnthropicModel("claude-sonnet-4-6");
  assert.equal(mapReasoningToAnthropicEffort("xhigh", custom46), "max");

  // Mythos Preview 只支持 max，不支持 xhigh。
  const mythos = createAnthropicModel("claude-mythos-preview");
  assert.equal(mapReasoningToAnthropicEffort("xhigh", mythos), "max");

  // 4.7+ 与 5 家族原生支持 xhigh。
  assert.equal(
    mapReasoningToAnthropicEffort("xhigh", createAnthropicModel("claude-opus-4-7")),
    "xhigh",
  );
  assert.equal(
    mapReasoningToAnthropicEffort("xhigh", createAnthropicModel("claude-sonnet-5")),
    "xhigh",
  );
});

test("anthropic: pre-4.6 models keep budget mode with the fixed budgets table", () => {
  const opus45 = createAnthropicModel("claude-opus-4-5");
  const runtime = resolveAnthropicThinkingRuntime(opus45, { reasoning: "high" });
  assert.equal(runtime.mode, "budget");
  assert.equal(runtime.thinkingBudgetTokens, 16_384);
  assert.equal(runtime.effort, undefined);
});

test("openai: xhigh only for codex-max and gpt-5.2+", () => {
  assert.equal(clampOpenAIReasoningEffort("gpt-5.1-codex-max", "xhigh"), "xhigh");
  assert.equal(clampOpenAIReasoningEffort("gpt-5.2", "xhigh"), "xhigh");
  assert.equal(clampOpenAIReasoningEffort("gpt-5.3-codex", "xhigh"), "xhigh");
  assert.equal(clampOpenAIReasoningEffort("gpt-5.5", "xhigh"), "xhigh");
  assert.equal(clampOpenAIReasoningEffort("gpt-5.1-codex", "xhigh"), "high");
  assert.equal(clampOpenAIReasoningEffort("gpt-5-codex", "xhigh"), "high");
  assert.equal(clampOpenAIReasoningEffort("gpt-5.1", "xhigh"), "high");
  assert.equal(clampOpenAIReasoningEffort("o3-mini", "xhigh"), "high");
});

test("openai: minimal clamps to low where the API rejects it", () => {
  assert.equal(clampOpenAIReasoningEffort("gpt-5-codex", "minimal"), "low");
  assert.equal(clampOpenAIReasoningEffort("gpt-5.1-codex-max", "minimal"), "low");
  assert.equal(clampOpenAIReasoningEffort("o3-mini", "minimal"), "low");
  assert.equal(clampOpenAIReasoningEffort("o1", "minimal"), "low");
  assert.equal(clampOpenAIReasoningEffort("gpt-5.1", "minimal"), "minimal");
  assert.equal(clampOpenAIReasoningEffort("gpt-5.1-codex-mini", "minimal"), "minimal");
});

test("openai: non-openai ids pass through untouched", () => {
  assert.equal(clampOpenAIReasoningEffort("qwen3-235b-a22b-thinking", "xhigh"), "xhigh");
  assert.equal(clampOpenAIReasoningEffort("deepseek-reasoner", "minimal"), "minimal");
  assert.equal(clampOpenAIReasoningEffort("glm-4.6", "xhigh"), "xhigh");
  assert.equal(clampOpenAIReasoningEffort("gpt-5.1", undefined), undefined);
});

test("gemini: 3.0 pro stays two-tier, 3.1+ pro gains MEDIUM", () => {
  assert.equal(mapGeminiThinkingLevel("gemini-3-pro-preview", "minimal"), "LOW");
  assert.equal(mapGeminiThinkingLevel("gemini-3-pro-preview", "low"), "LOW");
  assert.equal(mapGeminiThinkingLevel("gemini-3-pro-preview", "medium"), "HIGH");
  assert.equal(mapGeminiThinkingLevel("gemini-3-pro-preview", "high"), "HIGH");

  assert.equal(mapGeminiThinkingLevel("gemini-3.1-pro-preview", "minimal"), "LOW");
  assert.equal(mapGeminiThinkingLevel("gemini-3.1-pro-preview", "medium"), "MEDIUM");
  assert.equal(mapGeminiThinkingLevel("gemini-3.1-pro-preview", "high"), "HIGH");

  assert.equal(mapGeminiThinkingLevel("gemini-3-flash-preview", "minimal"), "MINIMAL");
  assert.equal(mapGeminiThinkingLevel("gemini-3-flash-preview", "medium"), "MEDIUM");
});

test("gemini: runtime picks level for 3.x and budget for 2.5, xhigh normalizes to high", () => {
  const pro31 = createGoogleModel("gemini-3.1-pro-preview");
  assert.deepEqual(resolveGeminiThinkingRuntime(pro31, "xhigh"), {
    enabled: true,
    level: "HIGH",
  });
  assert.deepEqual(resolveGeminiThinkingRuntime(pro31, "medium"), {
    enabled: true,
    level: "MEDIUM",
  });

  const pro25 = createGoogleModel("gemini-2.5-pro");
  assert.deepEqual(resolveGeminiThinkingRuntime(pro25, "high"), {
    enabled: true,
    budgetTokens: 32_768,
  });
  const flash25 = createGoogleModel("gemini-2.5-flash");
  assert.deepEqual(resolveGeminiThinkingRuntime(flash25, "high"), {
    enabled: true,
    budgetTokens: 24_576,
  });

  assert.deepEqual(resolveGeminiThinkingRuntime(pro31, undefined), { enabled: false });
});
