import type { ToolCall } from "@earendil-works/pi-ai";

export const LIVE_TOOL_PREVIEW_META_KEY = "__liveagent_stream_preview";

const GATEWAY_TOOL_TEXT_PREVIEW_MAX_CHARS = 4000;

type PreviewFieldMetrics = {
  chars: number;
  lines: number;
  previewChars: number;
  truncated: boolean;
  strategy: "full" | "head-tail";
};

function countTextLines(input: string) {
  if (input.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 13) {
      lines += 1;
      if (input.charCodeAt(index + 1) === 10) {
        index += 1;
      }
    } else if (code === 10) {
      lines += 1;
    }
  }
  return lines;
}

function buildHeadTailPreview(input: string, maxChars = GATEWAY_TOOL_TEXT_PREVIEW_MAX_CHARS) {
  if (input.length <= maxChars) {
    return {
      text: input,
      metrics: {
        chars: input.length,
        lines: countTextLines(input),
        previewChars: input.length,
        truncated: false,
        strategy: "full" as const,
      },
    };
  }

  const omittedChars = Math.max(0, input.length - maxChars);
  const marker = `\n...[truncated ${omittedChars} chars]...\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const headChars = Math.max(0, Math.floor(budget * 0.68));
  const tailChars = Math.max(0, budget - headChars);
  const text =
    budget > 0
      ? `${input.slice(0, headChars)}${marker}${tailChars > 0 ? input.slice(-tailChars) : ""}`
      : input.slice(0, maxChars);

  return {
    text,
    metrics: {
      chars: input.length,
      lines: countTextLines(input),
      previewChars: text.length,
      truncated: true,
      strategy: "head-tail" as const,
    },
  };
}

function previewStringField(
  args: Record<string, unknown>,
  fieldName: string,
  fields: Record<string, PreviewFieldMetrics>,
) {
  const value = args[fieldName];
  if (typeof value !== "string") {
    return;
  }
  const preview = buildHeadTailPreview(value);
  args[fieldName] = preview.text;
  fields[fieldName] = preview.metrics;
}

export function buildGatewayToolCallPreviewArguments(toolCall: Pick<ToolCall, "name" | "arguments">) {
  const sourceArgs = toolCall.arguments || {};
  if (toolCall.name !== "Write" && toolCall.name !== "Edit") {
    return sourceArgs;
  }

  const args: Record<string, unknown> = { ...sourceArgs };
  const fields: Record<string, PreviewFieldMetrics> = {};

  if (toolCall.name === "Write") {
    previewStringField(args, "content", fields);
  } else if (toolCall.name === "Edit") {
    previewStringField(args, "old_string", fields);
    previewStringField(args, "new_string", fields);
  }

  if (Object.keys(fields).length > 0) {
    args[LIVE_TOOL_PREVIEW_META_KEY] = {
      version: 1,
      fields,
    };
  }

  return args;
}
