import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";

import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";

type SelectedModelInput = {
  customProviderId: string;
  model: string;
};

type CronTaskType = "bash" | "http" | "prompt";
type SystemCronTaskAction = "create" | "read" | "update" | "delete" | "list_logs";

type CronHttpRequestPayload = {
  id: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
};

type SystemCronTaskPayload = {
  name: string;
  description: string;
  cron: string;
  enabled: boolean;
  remainingExecutions?: number | null;
  type: CronTaskType;
  script?: string;
  requests?: CronHttpRequestPayload[];
  prompt?: string;
  selectedModel?: SelectedModelInput;
};

type SystemCronTaskManagerPayload = {
  action: SystemCronTaskAction;
  taskId?: string;
  task?: Partial<SystemCronTaskPayload> | SystemCronTaskPayload;
  limit?: number;
};

type SystemCronTaskResponse = {
  taskId: string;
  name: string;
  description: string;
  type: CronTaskType;
  cron: string;
  enabled: boolean;
  remainingExecutions?: number;
  script?: string;
  requests?: CronHttpRequestPayload[];
  prompt?: string;
  selectedModel?: SelectedModelInput;
};

type SystemCronTaskManagerResponse = {
  action: SystemCronTaskAction;
  task?: SystemCronTaskResponse;
  tasks?: SystemCronTaskResponse[];
  logs?: CronExecutionLogResponse[];
};

type CronExecutionLogResponse = {
  id: string;
  taskId: string;
  startedAt: number;
  success: boolean;
  durationMs: number;
  exitCode?: number | null;
  output: string;
};

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

const MANAGE_CRON_TASK_PARAMETERS = Type.Object({
  action: Type.Union(
    [
      Type.Literal("create"),
      Type.Literal("read"),
      Type.Literal("update"),
      Type.Literal("delete"),
      Type.Literal("list_logs"),
    ],
    {
      description:
        "Action for Settings -> Cron. Use create to add a scheduled task, read to list tasks or inspect one task, update to edit an existing task by task_id, delete to remove a task by task_id, and list_logs to view recent execution logs for one task.",
    },
  ),
  task_id: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Required for update, delete, and list_logs. Optional for read: omit it to list all cron tasks, or pass it to inspect one task before updating, deleting, or listing logs.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 500,
      description:
        "Maximum number of recent execution logs to return for action=list_logs. Defaults to 100 and is capped at 500.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Task name shown in Settings -> Cron. Required for create. Optional patch field for update.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description:
        "Optional operator-facing description. For update, omit this field to keep the current description.",
    }),
  ),
  cron: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Six-field cron expression in the format: second minute hour day month weekday. Required for create. Optional patch field for update when changing schedule.",
    }),
  ),
  type: Type.Optional(
    Type.Union([Type.Literal("bash"), Type.Literal("http"), Type.Literal("prompt")], {
      description:
        "Cron task implementation type. Required for create. Optional for update when switching the task kind.",
    }),
  ),
  enabled: Type.Optional(
    Type.Boolean({
      description:
        "Whether the cron task should be enabled. For create, omitted means true. For update, omit this field to keep the current enabled state.",
    }),
  ),
  remaining_executions: Type.Optional(
    Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], {
      description:
        "Remaining run count for this cron task. Omit or pass null for unlimited runs. Pass 0 only when the task should be exhausted and disabled.",
    }),
  ),
  remainingExecutions: Type.Optional(
    Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], {
      description:
        "Camel-case alias for remaining_executions. Prefer remaining_executions unless the caller already uses camelCase.",
    }),
  ),
  script: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Shell script for type=bash. Required for create when type is bash. For update, pass this field only when you want to replace the stored script.",
    }),
  ),
  requests: Type.Optional(
    Type.Array(
      Type.Object({
        url: Type.String({
          minLength: 1,
          description: "Absolute HTTP URL for a scheduled request.",
        }),
        method: Type.Optional(
          Type.String({
            description: "HTTP method for the scheduled request. Defaults to POST when omitted.",
          }),
        ),
        headers: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description: "Optional HTTP headers for the scheduled request.",
          }),
        ),
        body: Type.Optional(
          Type.Any({
            description: "Optional JSON body for the scheduled request.",
          }),
        ),
      }),
      {
        description:
          "HTTP request list for type=http. Required for create when type is http. For update, pass this field only when you want to replace the stored request list.",
      },
    ),
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "Prompt content for type=prompt. Required for create when type is prompt. For update, pass this field only when you want to replace the stored prompt.",
    }),
  ),
  selected_model: Type.Optional(
    Type.Object(
      {
        custom_provider_id: Type.String({
          minLength: 1,
          description: "Provider id from Settings -> Providers for a prompt cron task.",
        }),
        model: Type.String({
          minLength: 1,
          description: "Model id used by the prompt cron task.",
        }),
      },
      {
        description:
          "Prompt task model selector. For create, CronTaskManager always uses the current runtime model and ignores this field. For update, omit it to keep the existing stored prompt model.",
      },
    ),
  ),
});

function asErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOwnKey(value: Record<string, unknown>, key: string) {
  return Object.hasOwn(value, key);
}

function pickOwnValue(value: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (hasOwnKey(value, key)) {
      return value[key];
    }
  }
  return undefined;
}

function hasAnyOwnKey(value: Record<string, unknown>, keys: readonly string[]) {
  return keys.some((key) => hasOwnKey(value, key));
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseCronTaskType(
  value: unknown,
  options?: { required?: boolean; fieldLabel?: string },
): CronTaskType | undefined {
  const fieldLabel = options?.fieldLabel ?? "type";
  const normalized = normalizeText(value);
  if (!normalized) {
    if (options?.required) {
      throw new Error(`CronTaskManager ${fieldLabel} is required.`);
    }
    return undefined;
  }

  switch (normalized) {
    case "bash":
    case "http":
    case "prompt":
      return normalized;
    default:
      throw new Error(
        `CronTaskManager ${fieldLabel} must be one of: bash, http, prompt. Received: ${JSON.stringify(value)}`,
      );
  }
}

function requireCronTaskType(value: unknown, fieldLabel = "type"): CronTaskType {
  const parsed = parseCronTaskType(value, { required: true, fieldLabel });
  if (!parsed) {
    throw new Error(`CronTaskManager ${fieldLabel} is required.`);
  }
  return parsed;
}

function parseCronTaskAction(value: unknown): SystemCronTaskAction {
  const normalized = normalizeText(value);
  switch (normalized) {
    case "create":
    case "read":
    case "update":
    case "delete":
    case "list_logs":
      return normalized;
    default:
      throw new Error(
        `CronTaskManager action must be one of: create, read, update, delete, list_logs. Received: ${JSON.stringify(value)}`,
      );
  }
}

function parseSelectedModelInput(
  value: unknown,
  options?: { required?: boolean; fieldLabel?: string },
): SelectedModelInput | undefined {
  const fieldLabel = options?.fieldLabel ?? "selected_model";
  if (value == null) {
    if (options?.required) {
      throw new Error(`CronTaskManager ${fieldLabel} is required.`);
    }
    return undefined;
  }

  const obj = asRecord(value);
  if (!obj) {
    throw new Error(`CronTaskManager ${fieldLabel} must be an object.`);
  }
  const customProviderId = normalizeText(obj.custom_provider_id ?? obj.customProviderId);
  const model = normalizeText(obj.model);
  if (!customProviderId || !model) {
    throw new Error(
      `CronTaskManager ${fieldLabel} must include non-empty custom_provider_id and model.`,
    );
  }
  return { customProviderId, model };
}

function parseHttpMethod(value: unknown, fieldLabel: string): string {
  if (value == null) return "POST";
  if (typeof value !== "string") {
    throw new Error(`CronTaskManager ${fieldLabel} must be a string.`);
  }
  const normalized = value.trim().toUpperCase();
  if (!normalized) return "POST";
  if (!HTTP_METHODS.has(normalized)) {
    throw new Error(
      `CronTaskManager ${fieldLabel} must be one of: ${Array.from(HTTP_METHODS).join(", ")}.`,
    );
  }
  return normalized;
}

function canHttpMethodHaveBody(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function parseHeaderMap(value: unknown, fieldLabel: string): Record<string, string> | undefined {
  if (value == null) return undefined;
  const obj = asRecord(value);
  if (!obj) {
    throw new Error(`CronTaskManager ${fieldLabel} must be an object.`);
  }
  const headers: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(obj)) {
    const key = rawKey.trim();
    const text = typeof rawValue === "string" ? rawValue.trim() : String(rawValue ?? "").trim();
    if (!key || !text) continue;
    headers[key] = text;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseHttpRequests(
  value: unknown,
  options?: { required?: boolean; fieldLabel?: string },
): CronHttpRequestPayload[] | undefined {
  const fieldLabel = options?.fieldLabel ?? "requests";
  if (value == null) {
    if (options?.required) {
      throw new Error(`CronTaskManager ${fieldLabel} is required.`);
    }
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`CronTaskManager ${fieldLabel} must be an array of request objects.`);
  }
  if (value.length === 0) {
    throw new Error(`CronTaskManager ${fieldLabel} must contain at least one request.`);
  }

  return value.map((entry, index) => {
    const itemLabel = `${fieldLabel}[${index}]`;
    const obj = asRecord(entry);
    if (!obj) {
      throw new Error(`CronTaskManager ${itemLabel} must be an object.`);
    }

    const providedId = pickOwnValue(obj, ["id"]);
    const id =
      providedId == null
        ? crypto.randomUUID()
        : (() => {
            const normalized = normalizeText(providedId);
            if (!normalized) {
              throw new Error(`CronTaskManager ${itemLabel}.id must be a non-empty string.`);
            }
            return normalized;
          })();

    const url = normalizeText(obj.url);
    if (!url) {
      throw new Error(`CronTaskManager ${itemLabel}.url must be a non-empty string.`);
    }
    const method = parseHttpMethod(obj.method, `${itemLabel}.method`);
    const request: CronHttpRequestPayload = {
      id,
      url,
      method,
    };
    const headers = parseHeaderMap(obj.headers, `${itemLabel}.headers`);
    if (headers) request.headers = headers;
    if (canHttpMethodHaveBody(method) && hasOwnKey(obj, "body")) {
      request.body = obj.body;
    }
    return request;
  });
}

function normalizeCronTaskId(args: Record<string, unknown>) {
  return normalizeText(pickOwnValue(args, ["task_id", "taskId"]));
}

function parseCronLogsLimit(args: Record<string, unknown>) {
  const value = pickOwnValue(args, ["limit", "logs_limit", "logsLimit"]);
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("CronTaskManager limit must be a positive integer.");
  }
  return Math.min(value, 500);
}

function parseRemainingExecutionsInput(
  value: unknown,
  fieldLabel = "remaining_executions",
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`CronTaskManager ${fieldLabel} must be a non-negative integer or null.`);
  }
  return numeric;
}

function buildCronTaskCreatePayload(
  args: Record<string, unknown>,
  currentChatModel?: SelectedModelInput,
): SystemCronTaskPayload {
  const type = requireCronTaskType(args.type);
  const payload: SystemCronTaskPayload = {
    name: normalizeText(args.name),
    description: normalizeText(args.description),
    cron: normalizeText(args.cron),
    enabled: typeof args.enabled === "boolean" ? args.enabled : true,
    type,
  };
  const remainingExecutions = parseRemainingExecutionsInput(
    pickOwnValue(args, ["remaining_executions", "remainingExecutions"]),
  );
  if (remainingExecutions !== undefined && remainingExecutions !== null) {
    payload.remainingExecutions = remainingExecutions;
    if (remainingExecutions === 0) {
      payload.enabled = false;
    }
  }

  if (type === "bash") {
    const script = normalizeText(args.script);
    if (!script) {
      throw new Error("CronTaskManager script is required for type=bash.");
    }
    payload.script = script;
  } else if (type === "http") {
    payload.requests = parseHttpRequests(args.requests, { required: true });
  } else {
    const prompt = normalizeText(args.prompt);
    if (!prompt) {
      throw new Error("CronTaskManager prompt is required for type=prompt.");
    }
    payload.prompt = prompt;
    const selectedModel = currentChatModel;
    if (!selectedModel) {
      throw new Error(
        "CronTaskManager type=prompt requires a current runtime model, but none is available.",
      );
    }
    payload.selectedModel = selectedModel;
  }

  return payload;
}

function buildCronTaskUpdatePatch(args: Record<string, unknown>) {
  const patch: Partial<SystemCronTaskPayload> = {};

  if (hasOwnKey(args, "name")) {
    patch.name = normalizeText(args.name);
  }
  if (hasOwnKey(args, "description")) {
    patch.description = normalizeText(args.description);
  }
  if (hasOwnKey(args, "cron")) {
    patch.cron = normalizeText(args.cron);
  }
  if (hasOwnKey(args, "enabled")) {
    if (typeof args.enabled !== "boolean") {
      throw new Error("CronTaskManager enabled must be a boolean when provided.");
    }
    patch.enabled = args.enabled;
  }
  if (hasAnyOwnKey(args, ["remaining_executions", "remainingExecutions"])) {
    patch.remainingExecutions = parseRemainingExecutionsInput(
      pickOwnValue(args, ["remaining_executions", "remainingExecutions"]),
    );
    if (patch.remainingExecutions === 0) {
      patch.enabled = false;
    }
  }
  if (hasOwnKey(args, "type")) {
    patch.type = requireCronTaskType(args.type, "type when provided");
  }
  if (hasOwnKey(args, "script")) {
    const script = normalizeText(args.script);
    if (!script) {
      throw new Error("CronTaskManager script must be a non-empty string when provided.");
    }
    patch.script = script;
  }
  if (hasOwnKey(args, "requests")) {
    patch.requests = parseHttpRequests(args.requests, { required: true });
  }
  if (hasOwnKey(args, "prompt")) {
    const prompt = normalizeText(args.prompt);
    if (!prompt) {
      throw new Error("CronTaskManager prompt must be a non-empty string when provided.");
    }
    patch.prompt = prompt;
  }
  if (hasAnyOwnKey(args, ["selected_model", "selectedModel"])) {
    patch.selectedModel = parseSelectedModelInput(
      pickOwnValue(args, ["selected_model", "selectedModel"]),
      { required: true },
    );
  }

  return patch;
}

function buildCronTaskManagerInvokePayload(
  args: Record<string, unknown>,
  currentChatModel?: SelectedModelInput,
): SystemCronTaskManagerPayload {
  const action = parseCronTaskAction(args.action);
  if (hasOwnKey(args, "commands")) {
    throw new Error("CronTaskManager commands is no longer supported. Use script for type=bash.");
  }
  const taskId = normalizeCronTaskId(args);

  if (action === "create") {
    return {
      action,
      task: buildCronTaskCreatePayload(args, currentChatModel),
    };
  }

  if (action === "read") {
    return taskId ? { action, taskId } : { action };
  }

  if (action === "list_logs") {
    if (!taskId) {
      throw new Error("CronTaskManager task_id is required for action=list_logs.");
    }
    const limit = parseCronLogsLimit(args);
    return {
      action,
      taskId,
      ...(limit === undefined ? {} : { limit }),
    };
  }

  if (!taskId) {
    throw new Error(`CronTaskManager task_id is required for action=${action}.`);
  }

  if (action === "update") {
    return {
      action,
      taskId,
      task: buildCronTaskUpdatePatch(args),
    };
  }

  return {
    action,
    taskId,
  };
}

function formatSelectedModel(selectedModel?: SelectedModelInput) {
  if (!selectedModel) return undefined;
  return `${selectedModel.customProviderId} / ${selectedModel.model}`;
}

function buildCronTaskDetailLines(task: SystemCronTaskResponse) {
  return [
    `task_id: ${task.taskId}`,
    `name: ${JSON.stringify(task.name)}`,
    `description: ${JSON.stringify(task.description)}`,
    `type: ${task.type}`,
    `cron: ${task.cron}`,
    `enabled: ${task.enabled ? "true" : "false"}`,
    `remaining_executions: ${task.remainingExecutions ?? "unlimited"}`,
    typeof task.script === "string" ? `script: ${JSON.stringify(task.script)}` : "",
    task.requests ? `requests: ${JSON.stringify(task.requests)}` : "",
    typeof task.prompt === "string" ? `prompt: ${JSON.stringify(task.prompt)}` : "",
    task.selectedModel ? `selected_model: ${formatSelectedModel(task.selectedModel)}` : "",
  ].filter(Boolean);
}

function formatCronLogTimestamp(value: number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function buildCronLogLines(log: CronExecutionLogResponse, index: number) {
  const status = log.success ? "success" : "failed";
  const exitCode = typeof log.exitCode === "number" ? ` | exit_code=${log.exitCode}` : "";
  const output = log.output.trim();
  return [
    `${index + 1}. log_id=${log.id} | started_at=${formatCronLogTimestamp(log.startedAt)} | status=${status} | duration_ms=${log.durationMs}${exitCode}`,
    output ? `output:\n${output}` : "output: <empty>",
  ].join("\n");
}

function buildCronLogsResultText(logs: CronExecutionLogResponse[]) {
  if (logs.length === 0) {
    return "No cron execution logs found for this task.";
  }
  const successCount = logs.filter((log) => log.success).length;
  const failCount = logs.length - successCount;
  return [
    `Found ${logs.length} cron execution log(s). success=${successCount}, failed=${failCount}.`,
    ...logs.map(buildCronLogLines),
  ].join("\n\n");
}

function buildCronTaskManagerResultText(result: SystemCronTaskManagerResponse) {
  switch (result.action) {
    case "create":
      return result.task
        ? ["Created cron task.", ...buildCronTaskDetailLines(result.task)].join("\n")
        : "Created cron task.";
    case "update":
      return result.task
        ? ["Updated cron task.", ...buildCronTaskDetailLines(result.task)].join("\n")
        : "Updated cron task.";
    case "delete":
      return result.task
        ? ["Deleted cron task.", ...buildCronTaskDetailLines(result.task)].join("\n")
        : "Deleted cron task.";
    case "list_logs":
      return buildCronLogsResultText(result.logs ?? []);
    case "read":
    default: {
      if (result.task) {
        return ["Cron task details:", ...buildCronTaskDetailLines(result.task)].join("\n");
      }

      const tasks = result.tasks ?? [];
      if (tasks.length === 0) {
        return "No cron tasks found.";
      }
      return [
        `Found ${tasks.length} cron task(s):`,
        ...tasks.map(
          (task, index) =>
            `${index + 1}. task_id=${task.taskId} | name=${JSON.stringify(task.name)} | type=${task.type} | cron=${task.cron} | enabled=${task.enabled ? "true" : "false"} | remaining_executions=${task.remainingExecutions ?? "unlimited"}`,
        ),
        "Use action=read with task_id to inspect one task before action=update, action=delete, or action=list_logs.",
      ].join("\n");
    }
  }
}

export function createCronTools(params: {
  currentChatModel?: SelectedModelInput;
}): BuiltinToolBundle {
  const toolCronTaskManager: Tool = {
    name: "CronTaskManager",
    description:
      "Manage persistent scheduled tasks in Settings -> Cron. This is the built-in tool for scheduled automation in LiveAgent and is always available. Use action=create to create a new recurring task, action=read to list tasks or inspect one task, action=update to edit an existing task by task_id, action=delete to remove an existing task by task_id, and action=list_logs with task_id to view recent execution logs. If the user asks to modify, remove, or inspect logs for an existing scheduled task and you do not know the task_id or current configuration, call action=read first. Scheduled jobs must be represented with this cron tool rather than only described in text or faked with one-off execution. Supports bash, http, and prompt task types. Use remaining_executions for a finite remaining run count; omit it or pass null for unlimited runs. For bash tasks, provide a non-empty script string, not a JSON argv array. For prompt task creation, the cron model always inherits the current runtime model.",
    parameters: MANAGE_CRON_TASK_PARAMETERS,
  };

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const now = Date.now();

    if (signal?.aborted) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "Cancelled" }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    if (toolCall.name !== "CronTaskManager") {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    try {
      const payload = buildCronTaskManagerInvokePayload(
        (toolCall.arguments ?? {}) as Record<string, unknown>,
        params.currentChatModel,
      );
      const result = await invoke<SystemCronTaskManagerResponse>("system_manage_cron_task", {
        payload,
      });

      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: buildCronTaskManagerResultText(result) }],
        details: result,
        isError: false,
        timestamp: now,
      };
    } catch (err) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Cron task manager failed: ${asErrorMessage(err)}` }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }
  }

  return {
    groupId: "system",
    tools: [toolCronTaskManager],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        "CronTaskManager",
        {
          groupId: "system",
          kind: "system",
          isReadOnly: false,
          displayCategory: "system",
        },
      ],
    ]),
  };
}
