import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamAnthropic } from "@earendil-works/pi-ai/anthropic";
import { type GoogleOptions, streamGoogle } from "@earendil-works/pi-ai/google";
import {
  type OpenAICompletionsOptions,
  streamOpenAICompletions,
} from "@earendil-works/pi-ai/openai-completions";
import {
  type OpenAIResponsesOptions,
  streamOpenAIResponses,
} from "@earendil-works/pi-ai/openai-responses";
import { wrapDeepSeekDsmlToolCallStream } from "../deepSeekDsmlToolCallStream";
import {
  attachDeepSeekProviderPayloadAdapter,
  isDeepSeekAnthropicTarget,
  isDeepSeekTarget,
  mapDeepSeekReasoningEffort,
} from "../deepSeekProviderAdapter";
import { isRecord, resolveMaxTokens } from "./common";
import { normalizeStructuredToolCallHistoryForDeepSeek } from "./textModeToolRecovery";
import type { StreamOptionsEx, ToolChoice } from "./types";

type AnthropicEffort = "low" | "medium" | "high" | "max" | "xhigh";
type AnthropicThinkingMode = "disabled" | "adaptive" | "budget";
type AnthropicThinkingRuntime = {
  thinkingEnabled: boolean;
  mode: AnthropicThinkingMode;
  maxTokens: number;
  effort?: AnthropicEffort;
  thinkingBudgetTokens?: number;
  display?: "summarized";
  omitDisabledThinking?: boolean;
};

function supportsAdaptiveAnthropicThinking(modelId: string) {
  const id = modelId.toLowerCase();
  return (
    isAnthropicMythosPreview(id) ||
    isClaudeFamilyVersionAtLeast(id, "opus", 6) ||
    isClaudeFamilyVersionAtLeast(id, "sonnet", 6)
  );
}

function isAnthropicMythosPreview(modelId: string) {
  return modelId.toLowerCase().includes("mythos-preview");
}

function isClaudeFamilyVersionAtLeast(
  normalizedModelId: string,
  family: "opus" | "sonnet",
  minimumMinor: number,
) {
  const match = normalizedModelId.match(new RegExp(`${family}[-.]4[-.](\\d+)`));
  if (!match) return false;
  const minor = Number(match[1]);
  return Number.isFinite(minor) && minor >= minimumMinor;
}

function supportsXHighAnthropicEffort(modelId: string) {
  const id = modelId.toLowerCase();
  return id.includes("mythos-preview") || isClaudeFamilyVersionAtLeast(id, "opus", 7);
}

function supportsMaxAnthropicEffort(modelId: string) {
  const id = modelId.toLowerCase();
  return (
    id.includes("mythos-preview") ||
    id.includes("opus-4-6") ||
    id.includes("opus-4.6") ||
    id.includes("sonnet-4-6") ||
    id.includes("sonnet-4.6")
  );
}

const ANTHROPIC_THINKING_BUDGETS: Record<NonNullable<SimpleStreamOptions["reasoning"]>, number> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 16_384,
};

function mapReasoningToAnthropicEffort(
  reasoning: SimpleStreamOptions["reasoning"] | undefined,
  modelId: string,
): AnthropicEffort {
  // Anthropic effort: low / medium / high / max / xhigh（按模型能力降级）。
  const supportsMax = supportsMaxAnthropicEffort(modelId);

  switch (reasoning) {
    case "minimal":
      return "low";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      if (supportsXHighAnthropicEffort(modelId)) return "xhigh";
      return supportsMax ? "max" : "high";
    default:
      return "high";
  }
}

function resolveAnthropicThinkingRuntime(
  model: Model<any>,
  options: StreamOptionsEx,
): AnthropicThinkingRuntime {
  const maxTokens = resolveMaxTokens(options.maxTokens, model.maxTokens);
  if (!options.reasoning) {
    return {
      thinkingEnabled: false,
      mode: "disabled",
      maxTokens,
      omitDisabledThinking: isAnthropicMythosPreview(model.id),
    };
  }

  if (supportsAdaptiveAnthropicThinking(model.id)) {
    return {
      thinkingEnabled: true,
      mode: "adaptive",
      maxTokens,
      effort: mapReasoningToAnthropicEffort(options.reasoning, model.id),
      display: "summarized",
    };
  }

  let thinkingBudgetTokens = ANTHROPIC_THINKING_BUDGETS[options.reasoning];
  const adjustedMaxTokens = Math.min(maxTokens + thinkingBudgetTokens, model.maxTokens);
  if (adjustedMaxTokens <= thinkingBudgetTokens) {
    thinkingBudgetTokens = Math.max(0, adjustedMaxTokens - 1_024);
  }

  return {
    thinkingEnabled: true,
    mode: "budget",
    maxTokens: adjustedMaxTokens,
    thinkingBudgetTokens,
  };
}

function resolveDeepSeekAnthropicThinkingRuntime(
  model: Model<any>,
  options: StreamOptionsEx,
): AnthropicThinkingRuntime {
  const effort = mapDeepSeekReasoningEffort(options.reasoning) as AnthropicEffort | undefined;
  return {
    thinkingEnabled: Boolean(effort),
    mode: effort ? "adaptive" : "disabled",
    maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
    ...(effort ? { effort } : {}),
  };
}

function applyAnthropicThinkingPayloadOverride(
  payload: unknown,
  thinking: AnthropicThinkingRuntime,
): unknown {
  if (!isRecord(payload)) return payload;

  if (thinking.mode === "disabled" && thinking.omitDisabledThinking) {
    const { thinking: _thinking, ...rest } = payload;
    return rest;
  }

  if (thinking.mode !== "adaptive") return payload;

  const outputConfig: Record<string, unknown> = isRecord(payload.output_config)
    ? { ...payload.output_config }
    : {};
  if (thinking.effort) {
    outputConfig.effort = thinking.effort;
  }

  return {
    ...payload,
    thinking: {
      type: "adaptive",
      ...(thinking.display ? { display: thinking.display } : {}),
    },
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
  };
}

function attachAnthropicThinkingPayloadOverride(
  options: StreamOptionsEx,
  thinking: AnthropicThinkingRuntime,
): StreamOptionsEx {
  if (thinking.mode !== "adaptive" && !thinking.omitDisabledThinking) return options;

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = applyAnthropicThinkingPayloadOverride(payload, thinking);
      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }
      return nextPayload;
    },
  };
}

function mapToolChoiceToOpenAI(
  toolChoice: ToolChoice | undefined,
): OpenAICompletionsOptions["toolChoice"] | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "any") return "required";
  if (toolChoice === "auto" || toolChoice === "none") return toolChoice;
  return {
    type: "function",
    function: {
      name: toolChoice.name,
    },
  };
}

function mapToolChoiceToGoogle(
  toolChoice: ToolChoice | undefined,
): GoogleOptions["toolChoice"] | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "any") {
    return toolChoice;
  }
  return "auto";
}

function buildOpenAIBaseOptions(model: Model<any>, options: StreamOptionsEx) {
  return {
    temperature: options.temperature,
    maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
    signal: options.signal,
    apiKey: options.apiKey,
    cacheRetention: options.cacheRetention,
    sessionId: options.sessionId,
    headers: options.headers,
    onPayload: options.onPayload,
    maxRetryDelayMs: options.maxRetryDelayMs,
    metadata: options.metadata,
  };
}

type GeminiThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
type GeminiReasoningLevel = Exclude<NonNullable<StreamOptionsEx["reasoning"]>, "xhigh">;

function normalizeGeminiReasoning(
  reasoning: StreamOptionsEx["reasoning"] | undefined,
): GeminiReasoningLevel | undefined {
  if (reasoning === "xhigh") return "high";
  return reasoning;
}

function isGemini3ProModel(modelId: string) {
  return /gemini-3(?:\.\d+)?-pro/.test(modelId.toLowerCase());
}

function isGemini3FlashModel(modelId: string) {
  return /gemini-3(?:\.\d+)?-flash/.test(modelId.toLowerCase());
}

function mapGeminiThinkingLevel(
  modelId: string,
  reasoning: GeminiReasoningLevel,
): GeminiThinkingLevel {
  if (isGemini3ProModel(modelId)) {
    return reasoning === "minimal" || reasoning === "low" ? "LOW" : "HIGH";
  }

  switch (reasoning) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    default:
      return "HIGH";
  }
}

function mapGeminiThinkingBudget(modelId: string, reasoning: GeminiReasoningLevel) {
  const normalizedModelId = modelId.toLowerCase();
  if (normalizedModelId.includes("2.5-pro")) {
    return {
      minimal: 128,
      low: 2_048,
      medium: 8_192,
      high: 32_768,
    }[reasoning];
  }
  if (normalizedModelId.includes("2.5-flash")) {
    return {
      minimal: 128,
      low: 2_048,
      medium: 8_192,
      high: 24_576,
    }[reasoning];
  }
  return -1;
}

function resolveGeminiThinkingRuntime(
  model: Model<any>,
  reasoning: StreamOptionsEx["reasoning"] | undefined,
): GoogleOptions["thinking"] {
  const normalizedReasoning = normalizeGeminiReasoning(reasoning);
  if (!normalizedReasoning) {
    return { enabled: false };
  }

  if (isGemini3ProModel(model.id) || isGemini3FlashModel(model.id)) {
    return {
      enabled: true,
      level: mapGeminiThinkingLevel(model.id, normalizedReasoning),
    };
  }

  return {
    enabled: true,
    budgetTokens: mapGeminiThinkingBudget(model.id, normalizedReasoning),
  };
}

export function streamSimpleByApi(model: Model<any>, context: Context, options: StreamOptionsEx) {
  switch (model.api) {
    case "anthropic-messages": {
      // Anthropic：需要我们自己调用 streamAnthropic()，以便显式传 toolChoice（以及启用/禁用 thinking）。
      const isDeepSeekAnthropic =
        Boolean(options.deepSeekProviderAdapter || options.deepSeekDsmlToolCallRepair) ||
        isDeepSeekAnthropicTarget({
          api: model.api,
          baseUrl: model.baseUrl,
          modelId: model.id,
        });
      const anthropicThinking = isDeepSeekAnthropic
        ? resolveDeepSeekAnthropicThinkingRuntime(model, options)
        : resolveAnthropicThinkingRuntime(model, options);
      const anthropicOptions = isDeepSeekAnthropic
        ? attachDeepSeekProviderPayloadAdapter(options, {
            providerId: "claude_code",
            baseUrl: model.baseUrl,
            model,
          })
        : attachAnthropicThinkingPayloadOverride(options, anthropicThinking);
      const anthropicContext = isDeepSeekAnthropic
        ? normalizeStructuredToolCallHistoryForDeepSeek(context)
        : context;
      const stream = streamAnthropic(model as any, anthropicContext, {
        temperature: anthropicOptions.temperature,
        maxTokens: anthropicThinking.maxTokens,
        signal: anthropicOptions.signal,
        apiKey: anthropicOptions.apiKey,
        cacheRetention: anthropicOptions.cacheRetention,
        sessionId: anthropicOptions.sessionId,
        headers: anthropicOptions.headers,
        onPayload: anthropicOptions.onPayload,
        maxRetryDelayMs: anthropicOptions.maxRetryDelayMs,
        metadata: anthropicOptions.metadata,
        thinkingEnabled: anthropicThinking.thinkingEnabled,
        ...(anthropicThinking.effort ? { effort: anthropicThinking.effort as any } : {}),
        ...(anthropicThinking.thinkingBudgetTokens !== undefined
          ? { thinkingBudgetTokens: anthropicThinking.thinkingBudgetTokens }
          : {}),
        toolChoice: anthropicOptions.toolChoice ?? "none",
      });
      return isDeepSeekAnthropic || anthropicOptions.deepSeekDsmlToolCallRepair
        ? wrapDeepSeekDsmlToolCallStream(stream)
        : stream;
    }
    case "openai-completions": {
      const openAICompletionsOptions = isDeepSeekTarget({
        baseUrl: model.baseUrl,
        modelId: model.id,
      })
        ? attachDeepSeekProviderPayloadAdapter(options, {
            providerId: "codex",
            baseUrl: model.baseUrl,
            model,
          })
        : options;
      const openAICompletionsContext = openAICompletionsOptions.deepSeekProviderAdapter
        ? normalizeStructuredToolCallHistoryForDeepSeek(context)
        : context;
      const openAIOptions: OpenAICompletionsOptions = {
        ...buildOpenAIBaseOptions(model, openAICompletionsOptions),
        reasoningEffort: openAICompletionsOptions.reasoning,
        toolChoice: mapToolChoiceToOpenAI(openAICompletionsOptions.toolChoice),
      };
      return streamOpenAICompletions(model as any, openAICompletionsContext, openAIOptions);
    }
    case "openai-responses": {
      const openAIOptions: OpenAIResponsesOptions = {
        ...buildOpenAIBaseOptions(model, options),
        reasoningEffort: options.reasoning,
      };
      return streamOpenAIResponses(model as any, context, openAIOptions);
    }
    case "google-generative-ai": {
      const googleOptions: GoogleOptions = {
        temperature: options.temperature,
        maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
        signal: options.signal,
        apiKey: options.apiKey,
        headers: options.headers,
        onPayload: options.onPayload,
        maxRetryDelayMs: options.maxRetryDelayMs,
        metadata: options.metadata,
        thinking: resolveGeminiThinkingRuntime(model, options.reasoning),
        toolChoice: mapToolChoiceToGoogle(options.toolChoice) ?? "none",
      };
      return streamGoogle(model as any, context, googleOptions);
    }
    default:
      throw new Error(`Unsupported model API: ${model.api}`);
  }
}
