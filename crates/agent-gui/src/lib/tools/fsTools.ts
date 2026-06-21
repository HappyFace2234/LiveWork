import type {
  ImageContent,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { type TSchema, Type } from "typebox";
import {
  type BuiltinToolBundle,
  type BuiltinToolResultDetails,
  createBuiltinMetadataMap,
  type DeleteResultDetails,
  type DisplayImageItemDetails,
  type DisplayImageResultDetails,
  type EditResultDetails,
  type FileToolRoot,
  type GlobResultDetails,
  type GrepResultDetails,
  type ListResultDetails,
  type ReadDocumentResultDetails,
  type ReadImageResultDetails,
  type ReadNotebookResultDetails,
  type ReadPdfResultDetails,
  type ReadTextResultDetails,
  type WriteResultDetails,
} from "./builtinTypes";
import type { FileToolState } from "./fileToolState";
import {
  buildScopedPathError,
  formatScopedTarget,
  normalizeComparablePath,
  normalizeOptionalScopedRelPath,
  normalizeRequiredScopedRelPath,
  normalizeToolFileRoot,
  relativePathFromAbsolute,
} from "./pathUtils";
import {
  assertSkillMutationAllowed,
  assertSkillPathAllowedByPolicy,
  buildSkillAccessDeniedMessage,
  isSkillAccessPolicyRestrictive,
  type SkillAccessPolicy,
} from "./skillAccessPolicy";

type ToolOk<TDetails extends BuiltinToolResultDetails = BuiltinToolResultDetails> = {
  content: (TextContent | ImageContent)[];
  details: TDetails;
};

const MAX_DISPLAY_IMAGE_PATHS = 12;
const AUTO_EDIT_FULL_READ_MAX_LINES = 5_000;

type DisplayImageSourceType = "path" | "url" | "base64" | "auto";

type DisplayImageSourceInput = {
  source: string;
  sourceType: DisplayImageSourceType;
  mimeType?: string;
  root?: FileToolRoot;
  workdir?: string;
  scopedPath?: string;
};

type DisplayImageEntry = {
  content?: ImageContent;
  details: DisplayImageItemDetails;
};

type SystemListSkillFilesResponse = {
  rootDir?: string | null;
};

type ReadCommandResponse = {
  kind: "text" | "image" | "pdf" | "notebook" | "word" | "spreadsheet" | "archive";
  path: string;
  content?: string | null;
  truncated?: boolean | null;
  startLine?: number | null;
  numLines?: number | null;
  totalLines?: number | null;
  isPartialView?: boolean | null;
  pageStart?: number | null;
  numPages?: number | null;
  totalPages?: number | null;
  cellStart?: number | null;
  numCells?: number | null;
  totalCells?: number | null;
  mtimeMs: number;
  contentHash: string;
  mimeType?: string | null;
  data?: string | null;
  sizeBytes?: number | null;
};

type WriteCommandResponse = {
  path: string;
  mode: "rewrite";
  existedBefore: boolean;
  bytesWritten: number;
  mtimeMs: number;
  contentHash: string;
  totalLines: number;
};

type EditCommandResponse = {
  path: string;
  replacements: number;
  replaceAll: boolean;
  mtimeMs: number;
  contentHash: string;
  totalLines: number;
};

type DeleteCommandResponse = {
  path: string;
  kind: string;
};

type ListCommandResponse = {
  path?: string | null;
  depth: number;
  offset: number;
  maxResults: number;
  total: number;
  hasMore: boolean;
  entries: { path: string; kind: "file" | "dir" }[];
};

type GlobCommandResponse = {
  path?: string | null;
  pattern: string;
  sortBy: "path";
  offset: number;
  maxResults: number;
  total: number;
  hasMore: boolean;
  paths: string[];
};

type GrepCommandResponse = {
  path?: string | null;
  pattern: string;
  filePattern?: string | null;
  ignoreCase: boolean;
  outputMode: "content" | "files" | "count";
  headLimit: number;
  offset: number;
  context: number;
  multiline: boolean;
  matchCount: number;
  fileCount: number;
  hasMore: boolean;
  matches: Array<{
    path: string;
    line: number;
    text: string;
    before: string[];
    after: string[];
  }>;
  files: Array<{
    path: string;
    count: number;
    firstLine?: number | null;
  }>;
};

function asErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function previewSnippet(input: string, maxChars = 500) {
  const text = input || "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...(${text.length} chars total)...`;
}

function formatLineWindow(startLine: number, numLines: number, totalLines: number) {
  if (totalLines === 0 || numLines === 0) return "empty";
  const endLine = startLine + numLines - 1;
  return `${startLine}-${endLine} / ${totalLines}`;
}

function rootArgText(root: FileToolRoot) {
  return root === "workspace" ? 'root="workspace" (or omit root)' : `root="${root}"`;
}

function splitRelativeFilePath(path: string) {
  const parts = path.split("/");
  const fileName = parts.pop()?.trim() ?? "";
  const parentPath = parts.join("/");
  return {
    parentPath: parentPath || undefined,
    fileName,
  };
}

function buildScopedToolRuntimeError(params: {
  toolName: string;
  root: FileToolRoot;
  path?: string;
  error: unknown;
}) {
  const pathHint = params.path ? `path="${params.path}"` : "omit path";
  return [
    `${params.toolName} failed for ${formatScopedTarget(params.root, params.path)}: ${asErrorMessage(params.error)}`,
    `Retry with ${rootArgText(params.root)}, ${pathHint}.`,
    "If the target belongs to another tool root, switch root instead of using an absolute path.",
    "Use List/Glob/Grep with the same root to locate files. Do not use Bash for workspace or Skills file operations.",
  ].join(" ");
}

async function invokeScopedFileCommand<T>(params: {
  toolName: string;
  root: FileToolRoot;
  path?: string;
  command: string;
  args: Record<string, unknown>;
}) {
  try {
    return await invoke<T>(params.command, params.args);
  } catch (error) {
    throw new Error(buildScopedToolRuntimeError({ ...params, error }));
  }
}

export function createFsTools(params: {
  workdir: string;
  fileState: FileToolState;
  skillsRootEnabled?: boolean;
  skillsRootDir?: string;
  skillAccessPolicy?: SkillAccessPolicy;
}): BuiltinToolBundle {
  const { workdir, fileState } = params;
  const allowSkillsRoot = params.skillsRootEnabled === true;
  const skillAccessPolicy = params.skillAccessPolicy;
  let cachedSkillsRootDir =
    typeof params.skillsRootDir === "string" ? params.skillsRootDir.trim() : "";

  const rootParameterShape: Record<string, TSchema> = allowSkillsRoot
    ? {
        root: Type.Optional(
          Type.Union([Type.Literal("workspace"), Type.Literal("skills")], {
            description:
              'Sandbox the `path` resolves under. Omit (or "workspace") for files in the workspace root — this is the default. Use "skills" ONLY for files inside an installed Skill that is enabled in this conversation. Regardless of which root is selected, `path` MUST stay relative — never expand the root into an absolute path.',
          }),
        ),
      }
    : {};

  function withFileRootParameters(shape: Record<string, TSchema>) {
    return Type.Object({
      ...rootParameterShape,
      ...shape,
    });
  }

  function withImageRootParameters(shape: Record<string, TSchema>) {
    return Type.Object({
      ...(allowSkillsRoot
        ? {
            root: Type.Optional(
              Type.Union([Type.Literal("workspace"), Type.Literal("skills")], {
                description:
                  'Sandbox for local image path/paths/source/sources resolution. Omit when the image is workspace-relative (default), a URL, base64, or an absolute path OUTSIDE both the workspace and any installed Skill. Set "workspace" or "skills" when the image lives inside one of those roots — the local path must then be RELATIVE to that root, never absolute.',
              }),
            ),
          }
        : {}),
      ...shape,
    });
  }

  function normalizeRoot(args: any, toolName: string): FileToolRoot {
    return normalizeToolFileRoot(args?.root, `${toolName}.root`, {
      allowSkillsRoot,
    });
  }

  async function resolveSkillsRootDir() {
    if (!allowSkillsRoot) {
      throw new Error("root=skills is only available when Skills are enabled");
    }
    if (cachedSkillsRootDir) return cachedSkillsRootDir;
    const response = await invoke<SystemListSkillFilesResponse>("system_list_skill_files");
    const rootDir = typeof response.rootDir === "string" ? response.rootDir.trim() : "";
    if (!rootDir) {
      throw new Error("Skills root is unavailable; refresh Skills discovery and retry.");
    }
    cachedSkillsRootDir = rootDir;
    return cachedSkillsRootDir;
  }

  async function resolveRootWorkdir(root: FileToolRoot) {
    return root === "skills" ? resolveSkillsRootDir() : workdir;
  }

  function assertSkillsPathAccess(root: FileToolRoot, path: string, operation: string) {
    if (root !== "skills") return;
    assertSkillPathAllowedByPolicy(skillAccessPolicy, path, operation);
  }

  function assertSkillsPathMutationAccess(root: FileToolRoot, path: string, operation: string) {
    if (root !== "skills") return;
    assertSkillPathAllowedByPolicy(skillAccessPolicy, path, operation);
    assertSkillMutationAllowed(skillAccessPolicy, operation, path);
  }

  function assertOptionalSkillsPathAccess(
    root: FileToolRoot,
    path: string | undefined,
    operation: string,
  ) {
    if (root !== "skills") return;
    if (path) {
      assertSkillPathAllowedByPolicy(skillAccessPolicy, path, operation);
      return;
    }
    if (isSkillAccessPolicyRestrictive(skillAccessPolicy)) {
      throw new Error(
        buildSkillAccessDeniedMessage({
          operation,
          allowedSkillNames: skillAccessPolicy?.allowedSkillNames,
        }),
      );
    }
  }

  const toolRead: Tool = {
    name: "Read",
    description:
      "Read a text, image, PDF, notebook, Word, Excel/spreadsheet, or archive file from the workspace or an enabled Skill. For text files, use start_line (1-based) and limit for pagination. For PDFs, use page_start and page_limit. For notebooks (.ipynb), use cell_start and cell_limit. Word/Excel/archive files return a best-effort text preview or entry listing. Returns version metadata and may return an `unchanged` stub when content has not changed since the previous read. Use Image instead when the user asks to show, view, render, or display an image in the chat UI. Do not use Markdown image syntax or HTML img tags to display files.",
    parameters: withFileRootParameters({
      path: Type.String({
        description:
          'Required path to the file, RELATIVE to the selected `root` (NEVER absolute, NEVER starting with "/", "~/", or a drive letter; NEVER containing "../"). Examples: "src/App.tsx", "assets/logo.png" (workspace), or "my-skill/SKILL.md" (with root="skills"). If you have an absolute path that falls inside the workspace or Skills root, strip that root prefix and pass only the remainder.',
      }),
      start_line: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "1-based starting line for text files (default: 1)",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Maximum number of lines to read for text files (default: 200)",
        }),
      ),
      page_start: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "1-based starting page for PDF files (default: 1)",
        }),
      ),
      page_limit: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Maximum number of PDF pages to read (default: 5)",
        }),
      ),
      cell_start: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "1-based starting cell for notebook files (default: 1)",
        }),
      ),
      cell_limit: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Maximum number of notebook cells to summarize (default: 20)",
        }),
      ),
    }),
  };

  const toolImage: Tool = {
    name: "Image",
    description:
      'Display one or more images in the chat UI. This is the only supported way for assistant-side image rendering. Call it whenever the user asks to show, view, render, preview, open, or display images, and whenever another tool saves, downloads, screenshots, generates, or returns an image path/URL that the user should see. Supports workspace- or Skills-relative paths, external absolute paths (only when the image lives OUTSIDE both roots), http/https URLs, base64 data URLs, and SVG images (file, data URL, or raw XML). For images inside the workspace or installed Skills, use root="workspace" or root="skills" with path/paths or local source/sources relative to that root; do not expand either root into an absolute path. For remote images, pass url/urls or source/sources directly instead of downloading the image first, unless the user explicitly asks to save it locally. For remote images, pass `url` / `urls` / `source` / `sources` directly — do NOT download first unless the user asked to save it. Do not embed images in final text with Markdown image syntax, HTML img tags, file:// URLs, or local relative image paths.',
    parameters: withImageRootParameters({
      path: Type.Optional(
        Type.String({
          description:
            'Single local image path. WHEN `root` is "workspace" (or omitted with the image inside the workspace) or "skills": this path MUST be RELATIVE to the selected root — never an absolute path that points into that root. Examples: "uploads/1777533744503/001.jpg", "assets/logo.png" (workspace), or "my-skill/diagram.png" (with root="skills"). An ABSOLUTE local path like "/Users/me/Pictures/photo.png" is allowed ONLY when the image lives OUTSIDE both the workspace and every installed Skill (e.g., a user-attached image elsewhere on disk).',
        }),
      ),
      paths: Type.Optional(
        Type.Array(
          Type.String({
            description:
              "Local image path. Same rules as `path`: RELATIVE to the selected `root` when the image is inside the workspace or a Skill; an external ABSOLUTE path only when it lives outside both roots.",
          }),
          {
            minItems: 1,
            maxItems: MAX_DISPLAY_IMAGE_PATHS,
            description: "Multiple local image paths to display in order.",
          },
        ),
      ),
      url: Type.Optional(
        Type.String({
          description:
            "Single http/https image URL. Use this directly for remote images that only need to be displayed.",
        }),
      ),
      urls: Type.Optional(
        Type.Array(
          Type.String({
            description: "http/https image URL",
          }),
          {
            minItems: 1,
            maxItems: MAX_DISPLAY_IMAGE_PATHS,
            description:
              "Multiple remote image URLs to display in order without pre-downloading them.",
          },
        ),
      ),
      base64: Type.Optional(
        Type.String({
          description:
            "Single image as a data URL or raw base64. For raw base64, provide mimeType when possible.",
        }),
      ),
      base64s: Type.Optional(
        Type.Array(
          Type.String({
            description: "Image as a data URL or raw base64",
          }),
          {
            minItems: 1,
            maxItems: MAX_DISPLAY_IMAGE_PATHS,
            description:
              "Multiple base64 images to display in order. Prefer data URLs so the MIME type is explicit.",
          },
        ),
      ),
      mimeType: Type.Optional(
        Type.String({
          description:
            "MIME type for raw base64 input, for example image/png, image/jpeg, or image/svg+xml.",
        }),
      ),
      source: Type.Optional(
        Type.String({
          description:
            "Single generic image source. Accepted forms: workspace- or Skills-relative path (matching `root`), external absolute path OUTSIDE both roots, http/https URL, data URL, raw base64, or raw SVG XML. Prefer this for mixed or unknown source types. Same relative-path rule as `path`: never pass an absolute path that points into the workspace or a Skill — strip the root prefix instead.",
        }),
      ),
      sources: Type.Optional(
        Type.Array(
          Type.String({
            description:
              "Generic image source. Same accepted forms and same relative-path rule as `source` — never an absolute path that points into the workspace or a Skill.",
          }),
          {
            minItems: 1,
            maxItems: MAX_DISPLAY_IMAGE_PATHS,
            description:
              "Multiple mixed image sources to display in order. Use this for mixed path + URL + base64 galleries.",
          },
        ),
      ),
    }),
  };

  const toolWrite: Tool = {
    name: "Write",
    description:
      "Create a new text file or fully rewrite an existing text file. There is no append mode — to add content, Read the file first, then either Write the full new content or use Edit to insert. Existing files must have been Read first (under the same root) so the tool can validate version metadata and reject stale rewrites.",
    parameters: withFileRootParameters({
      path: Type.String({
        description:
          'Required path to the file, RELATIVE to the selected `root` (NEVER absolute, NEVER starting with "/", "~/", or a drive letter; NEVER containing "../"). Examples: "src/new-file.ts", "src/config.json" (workspace), or "my-skill/references/guide.md" (with root="skills"). If you have an absolute path that falls inside the workspace or Skills root, strip that root prefix and pass only the remainder.',
      }),
      content: Type.String({ description: "Entire text content to write" }),
      mode: Type.Optional(
        Type.Literal("rewrite", {
          description: "Only rewrite is supported; append is intentionally disabled",
        }),
      ),
    }),
  };

  const toolEdit: Tool = {
    name: "Edit",
    description:
      "Perform an exact-string replacement in a file you have already Read under the same root. Validates version metadata before writing and rejects stale edits — if the file changed after the last Read, Read it again before retrying. If `old_string` matches multiple places, either narrow it until unique or set `replace_all=true` explicitly.",
    parameters: withFileRootParameters({
      path: Type.String({
        description:
          'Required path to the file, RELATIVE to the selected `root` (NEVER absolute, NEVER starting with "/", "~/", or a drive letter; NEVER containing "../"). Examples: "src/App.tsx", "src/lib/chat.ts" (workspace), or "my-skill/SKILL.md" (with root="skills"). If you have an absolute path that falls inside the workspace or Skills root, strip that root prefix and pass only the remainder.',
      }),
      old_string: Type.String({ description: "Exact text to replace" }),
      new_string: Type.String({ description: "Replacement text" }),
      expected_replacements: Type.Optional(
        Type.Number({
          minimum: 1,
          description:
            "Expected number of actual replacements. Use together with replace_all for multi-match edits.",
        }),
      ),
      replace_all: Type.Optional(
        Type.Boolean({
          description:
            "Replace every exact match when true; otherwise only a single unambiguous match is allowed",
        }),
      ),
    }),
  };

  const toolDelete: Tool = {
    name: "Delete",
    description:
      "Delete a file or directory under the selected root. Directories are removed recursively. Use this instead of Bash rm, rmdir, unlink, or find -delete for workspace or Skill files. Use this instead of Bash `rm` / `rmdir` / `unlink` / `find -delete` for any workspace or Skill file.",
    parameters: withFileRootParameters({
      path: Type.String({
        description:
          'Required path to the file or directory to delete, RELATIVE to the selected `root` (NEVER absolute, NEVER starting with "/", "~/", or a drive letter; NEVER containing "../"). Examples: "src/old-file.ts", "tmp/cache" (workspace), or "my-skill/references/old.md" (with root="skills"). If you have an absolute path that falls inside the workspace or Skills root, strip that root prefix and pass only the remainder.',
      }),
    }),
  };

  const toolList: Tool = {
    name: "List",
    description:
      "List files and directories under the selected root using ignore-aware traversal. Supports depth-limited traversal and paginated results. Prefer this over `Bash ls` / `find` for workspace or Skill content.",
    parameters: withFileRootParameters({
      path: Type.Optional(
        Type.String({
          description:
            'Optional directory, RELATIVE to the selected `root`. Omit (do NOT pass `.`, `./`, or `.\\`) to list the root itself. Examples: "src/lib", "src" (workspace), or "my-skill/references" (with root="skills"). NEVER pass an absolute path, "../", or "~/". If you have an absolute path inside the workspace or Skills root, strip that root prefix and pass only the remainder.',
        }),
      ),
      depth: Type.Optional(
        Type.Number({ minimum: 1, description: "Recursion depth (default: 2)" }),
      ),
      offset: Type.Optional(
        Type.Number({ minimum: 0, description: "Pagination offset (default: 0)" }),
      ),
      max_results: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Maximum number of entries to return (default: 200)",
        }),
      ),
    }),
  };

  const toolGlob: Tool = {
    name: "Glob",
    description:
      "Find files by glob pattern using ignore-aware traversal. Results are paginated and sorted by path. Prefer this over `Bash find` for workspace or Skill content.",
    parameters: withFileRootParameters({
      pattern: Type.String({
        description:
          'Glob pattern relative to the search root, for example "**/*.tsx" or "src/**/Chat*.ts". Use `/` as the separator (Windows `\\` is auto-normalized).',
      }),
      path: Type.Optional(
        Type.String({
          description:
            'Optional sub-directory to search under, RELATIVE to the selected `root`. Omit to search from the root itself. Examples: "src", "src/lib" (workspace), or "my-skill" (with root="skills"). NEVER pass an absolute path, "../", or "~/". If you have an absolute path inside the workspace or Skills root, strip that root prefix and pass only the remainder.',
        }),
      ),
      offset: Type.Optional(
        Type.Number({ minimum: 0, description: "Pagination offset (default: 0)" }),
      ),
      max_results: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Maximum number of results to return (default: 200)",
        }),
      ),
      sort_by: Type.Optional(
        Type.Literal("path", {
          description: "Sorting mode. Only path sorting is currently supported.",
        }),
      ),
    }),
  };

  const toolGrep: Tool = {
    name: "Grep",
    description:
      "Search file contents using a regular expression with ignore-aware traversal. Supports output_mode=content|files|count, pagination, optional surrounding context, and multiline matching. Prefer this over `Bash grep` / `rg` for any workspace or Skill content.",
    parameters: withFileRootParameters({
      pattern: Type.String({ description: "Regular expression to search for in file contents." }),
      path: Type.Optional(
        Type.String({
          description:
            'Optional sub-directory to search under, RELATIVE to the selected `root`. Omit to search from the root itself. Examples: "src/lib", "crates/agent-gui" (workspace), or "my-skill" (with root="skills"). NEVER pass an absolute path, "../", or "~/". If you have an absolute path inside the workspace or Skills root, strip that root prefix and pass only the remainder.',
        }),
      ),
      file_pattern: Type.Optional(
        Type.String({
          description: "Optional glob filter, for example **/*.ts|**/*.tsx",
        }),
      ),
      ignore_case: Type.Optional(
        Type.Boolean({ description: "Case-insensitive when true (default: true)" }),
      ),
      output_mode: Type.Optional(
        Type.Union([Type.Literal("content"), Type.Literal("files"), Type.Literal("count")]),
      ),
      head_limit: Type.Optional(
        Type.Number({
          minimum: 1,
          description:
            "Maximum number of rows to return for the selected output mode (default: 200)",
        }),
      ),
      offset: Type.Optional(
        Type.Number({ minimum: 0, description: "Pagination offset (default: 0)" }),
      ),
      context: Type.Optional(
        Type.Number({
          minimum: 0,
          description: "Number of surrounding lines to include around each match (default: 0)",
        }),
      ),
      multiline: Type.Optional(
        Type.Boolean({
          description: "Enable multiline regular expression matching when true",
        }),
      ),
    }),
  };

  const tools: Tool[] = [
    toolRead,
    toolImage,
    toolWrite,
    toolEdit,
    toolDelete,
    toolList,
    toolGlob,
    toolGrep,
  ];

  async function execRead(args: any, signal?: AbortSignal): Promise<ToolOk> {
    if (signal?.aborted) throw new Error("Cancelled");

    const root = normalizeRoot(args, "Read");
    const scopedWorkdir = await resolveRootWorkdir(root);
    const path = normalizeRequiredScopedRelPath({
      input: args?.path,
      label: "Read.path",
      expectedRoot: root,
      workdir,
      skillsRootDir: cachedSkillsRootDir,
    });
    assertSkillsPathAccess(root, path, 'Read(root="skills")');
    const start_line = typeof args?.start_line === "number" ? args.start_line : undefined;
    const limit = typeof args?.limit === "number" ? args.limit : undefined;
    const page_start = typeof args?.page_start === "number" ? args.page_start : undefined;
    const page_limit = typeof args?.page_limit === "number" ? args.page_limit : undefined;
    const cell_start = typeof args?.cell_start === "number" ? args.cell_start : undefined;
    const cell_limit = typeof args?.cell_limit === "number" ? args.cell_limit : undefined;

    const res = await invokeScopedFileCommand<ReadCommandResponse>({
      toolName: "Read",
      root,
      path,
      command: "fs_read_text",
      args: {
        workdir: scopedWorkdir,
        path,
        start_line,
        limit,
        page_start,
        page_limit,
        cell_start,
        cell_limit,
      },
    });

    if (res.kind === "image") {
      const baseDetails: ReadImageResultDetails = {
        kind: "read_image",
        root,
        path,
        mimeType: String(res.mimeType || "application/octet-stream"),
        sizeBytes: typeof res.sizeBytes === "number" ? res.sizeBytes : 0,
        mtimeMs: res.mtimeMs,
        contentHash: res.contentHash,
        reusedExisting: false,
      };
      const previous = fileState.getExactImageRead(path, root);
      const reusedExisting =
        previous?.kind === "image" &&
        previous.mtimeMs === baseDetails.mtimeMs &&
        previous.contentHash === baseDetails.contentHash;
      const details: ReadImageResultDetails = {
        ...baseDetails,
        reusedExisting,
      };
      fileState.recordImageRead(details);

      if (reusedExisting) {
        return {
          content: [
            {
              type: "text",
              text: `Read image: ${formatScopedTarget(root, path)}\nThis image is unchanged since the previous Read. Reuse the earlier image result.`,
            },
          ],
          details,
        };
      }

      if (typeof res.data !== "string" || !res.data) {
        throw new Error(`Read did not return image bytes for ${path}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `Read image: ${formatScopedTarget(root, path)}\nmime=${details.mimeType}\nsizeBytes=${details.sizeBytes}`,
          },
          {
            type: "image",
            data: res.data,
            mimeType: details.mimeType,
          },
        ],
        details,
      };
    }

    if (res.kind === "pdf") {
      const pageStart = typeof res.pageStart === "number" ? res.pageStart : 1;
      const numPages = typeof res.numPages === "number" ? res.numPages : 0;
      const totalPages = typeof res.totalPages === "number" ? res.totalPages : 0;
      const baseDetails: ReadPdfResultDetails = {
        kind: "read_pdf",
        root,
        path,
        pageStart,
        numPages,
        totalPages,
        truncated: Boolean(res.truncated),
        mtimeMs: res.mtimeMs,
        contentHash: res.contentHash,
        reusedExisting: false,
      };
      const previous = fileState.getExactPdfRead(
        path,
        {
          pageStart,
          numPages,
          totalPages,
        },
        root,
      );
      const reusedExisting =
        previous?.kind === "pdf" &&
        previous.mtimeMs === baseDetails.mtimeMs &&
        previous.contentHash === baseDetails.contentHash;
      const details: ReadPdfResultDetails = {
        ...baseDetails,
        reusedExisting,
      };
      fileState.recordPdfRead(details);

      if (reusedExisting) {
        return {
          content: [
            {
              type: "text",
              text:
                `Read PDF: ${formatScopedTarget(root, path)}\n` +
                `pages=${details.numPages > 0 ? `${details.pageStart}-${details.pageStart + details.numPages - 1}/${details.totalPages}` : `empty/${details.totalPages}`}\n` +
                "This page range is unchanged since the previous Read. Reuse the earlier content.",
            },
          ],
          details,
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Read PDF: ${formatScopedTarget(root, path)}\n` +
              `pages=${details.numPages > 0 ? `${details.pageStart}-${details.pageStart + details.numPages - 1}/${details.totalPages}` : `empty/${details.totalPages}`}\n\n` +
              `${typeof res.content === "string" && res.content ? res.content : "(no extractable text)"}`,
          },
        ],
        details,
      };
    }

    if (res.kind === "notebook") {
      const cellStart = typeof res.cellStart === "number" ? res.cellStart : 1;
      const numCells = typeof res.numCells === "number" ? res.numCells : 0;
      const totalCells = typeof res.totalCells === "number" ? res.totalCells : 0;
      const baseDetails: ReadNotebookResultDetails = {
        kind: "read_notebook",
        root,
        path,
        cellStart,
        numCells,
        totalCells,
        truncated: Boolean(res.truncated),
        mtimeMs: res.mtimeMs,
        contentHash: res.contentHash,
        reusedExisting: false,
      };
      const previous = fileState.getExactNotebookRead(
        path,
        {
          cellStart,
          numCells,
          totalCells,
        },
        root,
      );
      const reusedExisting =
        previous?.kind === "notebook" &&
        previous.mtimeMs === baseDetails.mtimeMs &&
        previous.contentHash === baseDetails.contentHash;
      const details: ReadNotebookResultDetails = {
        ...baseDetails,
        reusedExisting,
      };
      fileState.recordNotebookRead(details);

      if (reusedExisting) {
        return {
          content: [
            {
              type: "text",
              text:
                `Read notebook: ${formatScopedTarget(root, path)}\n` +
                `cells=${details.numCells > 0 ? `${details.cellStart}-${details.cellStart + details.numCells - 1}/${details.totalCells}` : `empty/${details.totalCells}`}\n` +
                "This cell range is unchanged since the previous Read. Reuse the earlier content.",
            },
          ],
          details,
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Read notebook: ${formatScopedTarget(root, path)}\n` +
              `cells=${details.numCells > 0 ? `${details.cellStart}-${details.cellStart + details.numCells - 1}/${details.totalCells}` : `empty/${details.totalCells}`}\n\n` +
              `${typeof res.content === "string" && res.content ? res.content : "(empty notebook)"}`,
          },
        ],
        details,
      };
    }

    if (res.kind === "word" || res.kind === "spreadsheet" || res.kind === "archive") {
      const label =
        res.kind === "word"
          ? "Word document"
          : res.kind === "spreadsheet"
            ? "spreadsheet"
            : "archive";
      const details: ReadDocumentResultDetails = {
        kind:
          res.kind === "word"
            ? "read_word"
            : res.kind === "spreadsheet"
              ? "read_spreadsheet"
              : "read_archive",
        root,
        path,
        truncated: Boolean(res.truncated),
        mimeType: typeof res.mimeType === "string" ? res.mimeType : undefined,
        sizeBytes: typeof res.sizeBytes === "number" ? res.sizeBytes : undefined,
        mtimeMs: res.mtimeMs,
        contentHash: res.contentHash,
        reusedExisting: false,
      };

      return {
        content: [
          {
            type: "text",
            text:
              `Read ${label}: ${formatScopedTarget(root, path)}\n` +
              [
                details.mimeType ? `mime=${details.mimeType}` : null,
                typeof details.sizeBytes === "number" ? `sizeBytes=${details.sizeBytes}` : null,
                details.truncated ? "truncated=true" : null,
              ]
                .filter((item): item is string => Boolean(item))
                .join("\n") +
              "\n\n" +
              `${typeof res.content === "string" && res.content ? res.content : "(no preview available)"}`,
          },
        ],
        details,
      };
    }

    const startLine = typeof res.startLine === "number" ? res.startLine : 1;
    const numLines = typeof res.numLines === "number" ? res.numLines : 0;
    const totalLines = typeof res.totalLines === "number" ? res.totalLines : 0;
    const baseDetails: ReadTextResultDetails = {
      kind: "read_text",
      root,
      path,
      startLine,
      numLines,
      totalLines,
      truncated: Boolean(res.truncated),
      isPartialView: Boolean(res.isPartialView),
      mtimeMs: res.mtimeMs,
      contentHash: res.contentHash,
      reusedExisting: false,
    };
    const previous = fileState.getExactTextRead(
      path,
      {
        startLine,
        numLines,
        totalLines,
      },
      root,
    );
    const reusedExisting =
      previous?.kind === "text" &&
      previous.mtimeMs === baseDetails.mtimeMs &&
      previous.contentHash === baseDetails.contentHash;
    const details: ReadTextResultDetails = {
      ...baseDetails,
      reusedExisting,
    };
    fileState.recordTextRead(details);

    if (reusedExisting) {
      return {
        content: [
          {
            type: "text",
            text:
              `Read: ${formatScopedTarget(root, path)}\n` +
              `lines=${formatLineWindow(details.startLine, details.numLines, details.totalLines)}\n` +
              "This range is unchanged since the previous Read. Reuse the earlier content.",
          },
        ],
        details,
      };
    }

    const header = [
      `Read: ${formatScopedTarget(root, path)}`,
      `lines=${formatLineWindow(details.startLine, details.numLines, details.totalLines)}`,
      details.isPartialView ? "view=partial" : "view=full",
    ].join("\n");
    const body = typeof res.content === "string" && res.content ? res.content : "(empty file)";
    const suffix = details.truncated ? "\n\n[...truncated...]\n" : "";

    return {
      content: [{ type: "text", text: `${header}\n\n${body}${suffix}` }],
      details,
    };
  }

  async function primeFullTextSnapshotForEdit(params: {
    root: FileToolRoot;
    path: string;
    signal?: AbortSignal;
  }) {
    const existingSnapshot = fileState.getLatestFullText(params.path, params.root);
    if (existingSnapshot) {
      return { snapshot: existingSnapshot, autoRead: false };
    }

    const latest = fileState.getLatest(params.path, params.root);
    let readLimit = AUTO_EDIT_FULL_READ_MAX_LINES;
    if (latest?.kind === "text" && latest.totalLines > 0) {
      if (latest.totalLines > AUTO_EDIT_FULL_READ_MAX_LINES) {
        throw new Error(
          `Edit requires a full-file Read first. ${formatScopedTarget(params.root, params.path)} has ${latest.totalLines} lines, which exceeds the automatic full-read limit (${AUTO_EDIT_FULL_READ_MAX_LINES}). Retry with Read using the same root and path and a limit that covers the full file before editing. Do not use Bash for workspace or Skills file operations.`,
        );
      }
      readLimit = latest.totalLines;
    }

    await execRead(
      {
        root: params.root,
        path: params.path,
        limit: readLimit,
      },
      params.signal,
    );

    const snapshot = fileState.getLatestFullText(params.path, params.root);
    if (snapshot) {
      return { snapshot, autoRead: true };
    }

    const latestAfterRead = fileState.getLatest(params.path, params.root);
    if (latestAfterRead?.kind === "text" && latestAfterRead.isPartialView) {
      throw new Error(
        `Edit requires a full-file Read first. ${formatScopedTarget(params.root, params.path)} has ${latestAfterRead.totalLines} lines, which exceeds the automatic full-read limit (${AUTO_EDIT_FULL_READ_MAX_LINES}). Retry with Read using the same root and path and a limit that covers the full file before editing. Do not use Bash for workspace or Skills file operations.`,
      );
    }

    throw new Error(
      `Edit requires a full-file text Read first for ${formatScopedTarget(params.root, params.path)}. Retry with Read using the same root and path before editing. Do not use Bash for workspace or Skills file operations.`,
    );
  }

  function normalizeRequiredImageSource(input: unknown, label: string) {
    const value = typeof input === "string" ? input.trim() : "";
    if (!value) {
      throw new Error(`${label} must be a non-empty string`);
    }
    return value;
  }

  function getOptionalMimeType(args: any) {
    const value =
      typeof args?.mimeType === "string"
        ? args.mimeType
        : typeof args?.mime_type === "string"
          ? args.mime_type
          : "";
    return value.trim() || undefined;
  }

  function pushImageSources(
    sources: DisplayImageSourceInput[],
    rawItems: unknown[],
    sourceType: DisplayImageSourceType,
    label: string,
    mimeType?: string,
    root?: FileToolRoot,
    scopedWorkdir?: string,
    rootExplicit = false,
  ) {
    rawItems.forEach((item, index) => {
      const itemLabel = rawItems.length > 1 ? `${label}[${index}]` : label;
      const normalized =
        sourceType === "path"
          ? normalizeImageLocalPathSource(item, itemLabel, root, scopedWorkdir, rootExplicit)
          : {
              source: normalizeRequiredImageSource(item, itemLabel),
              root: undefined,
              workdir: undefined,
              scopedPath: undefined,
            };
      sources.push({
        source: normalized.source,
        sourceType,
        mimeType,
        root: normalized.root,
        workdir: normalized.workdir,
        scopedPath: normalized.scopedPath,
      });
    });
  }

  function inferGenericImageSourceType(source: string): DisplayImageSourceType {
    if (/^data:image\//i.test(source)) return "base64";
    if (/^https?:\/\//i.test(source)) return "url";
    const compact = source.replace(/\s/g, "");
    if (/^(iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|Qk|AAABAA|PHN2Z|PD94bWwg)/.test(compact)) {
      return "base64";
    }
    return "auto";
  }

  function isInlineSvgSource(source: string) {
    const value = source.trimStart();
    return /^<\?xml\b/i.test(value) || /^<svg\b/i.test(value);
  }

  function inferHomeDirFromKnownRoot(rootDir: string | undefined) {
    const value = normalizeComparablePath(rootDir || "");
    if (!value) return null;
    const unixHome = value.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
    if (unixHome) return unixHome[1];
    const windowsHome = value.match(/^([a-zA-Z]:\/Users\/[^/]+)/);
    return windowsHome ? windowsHome[1] : null;
  }

  function expandTildeForKnownRootCheck(value: string) {
    if (value !== "~" && !value.startsWith("~/") && !value.startsWith("~\\")) {
      return value;
    }
    const suffix = value === "~" ? "" : value.slice(1).replace(/\\/g, "/");
    const homes = [
      inferHomeDirFromKnownRoot(cachedSkillsRootDir),
      inferHomeDirFromKnownRoot(workdir),
    ].filter((home): home is string => Boolean(home));
    for (const home of homes) {
      const expanded = `${home}${suffix}`;
      if (relativePathFromAbsolute(expanded, workdir) !== null) return expanded;
      if (cachedSkillsRootDir && relativePathFromAbsolute(expanded, cachedSkillsRootDir) !== null) {
        return expanded;
      }
    }
    return value;
  }

  function localPathCandidateForRootCheck(source: string) {
    const value = source.trim();
    if (!value) return null;
    if (/^file:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (url.protocol !== "file:") return null;
        return decodeURIComponent(url.pathname || "");
      } catch {
        return value;
      }
    }
    if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("~")) {
      return expandTildeForKnownRootCheck(value);
    }
    return null;
  }

  function relativePathFromDefaultLiveAgentSkillsRoot(rawPath: string) {
    const path = normalizeComparablePath(rawPath);
    if (!path) return null;

    const tildePrefix = "~/.liveagent/skills";
    if (path === tildePrefix) return "";
    if (path.startsWith(`${tildePrefix}/`)) return path.slice(tildePrefix.length + 1);

    const marker = "/.liveagent/skills";
    const markerIndex = path.toLowerCase().indexOf(marker);
    if (markerIndex < 0) return null;
    const suffix = path.slice(markerIndex + marker.length);
    if (!suffix) return "";
    return suffix.startsWith("/") ? suffix.slice(1) : null;
  }

  function buildDefaultSkillsRootPathError(label: string, relativePath: string) {
    const pathHint = relativePath
      ? `path="${relativePath}"`
      : "path=<relative file path inside the enabled Skill>";
    return [
      `${label} points inside LiveAgent's fixed Skills root and is blocked in this conversation.`,
      `Enable the Skill in the chat Skills selector, then retry with root="skills", ${pathHint}.`,
      "Do not use absolute ~/.liveagent/skills paths or file:// URLs to access installed Skills.",
    ].join(" ");
  }

  function scopedRootPathErrorIfKnownRoot(label: string, source: string) {
    const localPath = localPathCandidateForRootCheck(source);
    if (!localPath) return null;
    if (relativePathFromAbsolute(localPath, workdir) !== null) {
      return buildScopedPathError({
        label,
        rawPath: localPath,
        workdir,
        skillsRootDir: cachedSkillsRootDir,
        required: true,
      });
    }
    if (cachedSkillsRootDir && relativePathFromAbsolute(localPath, cachedSkillsRootDir) !== null) {
      return buildScopedPathError({
        label,
        rawPath: localPath,
        workdir,
        skillsRootDir: cachedSkillsRootDir,
        required: true,
      });
    }
    const defaultSkillsRelativePath = relativePathFromDefaultLiveAgentSkillsRoot(localPath);
    if (defaultSkillsRelativePath !== null) {
      return buildDefaultSkillsRootPathError(label, defaultSkillsRelativePath);
    }
    return null;
  }

  function normalizeImageLocalPathSource(
    input: unknown,
    label: string,
    root?: FileToolRoot,
    scopedWorkdir?: string,
    rootExplicit = false,
  ) {
    const source = normalizeRequiredImageSource(input, label);
    if (root === "skills" || rootExplicit) {
      const scopedPath = normalizeRequiredScopedRelPath({
        input: source,
        label,
        expectedRoot: root ?? "workspace",
        workdir,
        skillsRootDir: cachedSkillsRootDir,
      });
      assertSkillsPathAccess(root ?? "workspace", scopedPath, 'Image(root="skills")');
      return {
        source: scopedPath,
        root,
        workdir: scopedWorkdir,
        scopedPath,
      };
    }

    const knownRootPathError = scopedRootPathErrorIfKnownRoot(label, source);
    if (knownRootPathError) {
      throw new Error(knownRootPathError);
    }

    if (localPathCandidateForRootCheck(source)) {
      return {
        source,
        root: undefined,
        workdir: undefined,
        scopedPath: undefined,
      };
    }

    const scopedPath = normalizeRequiredScopedRelPath({
      input: source,
      label,
      expectedRoot: "workspace",
      workdir,
      skillsRootDir: cachedSkillsRootDir,
    });

    return {
      source: scopedPath,
      root: "workspace" as const,
      workdir: scopedWorkdir,
      scopedPath,
    };
  }

  function pushGenericImageSources(
    sources: DisplayImageSourceInput[],
    rawItems: unknown[],
    label: string,
    mimeType?: string,
    root?: FileToolRoot,
    scopedWorkdir?: string,
    rootExplicit = false,
  ) {
    rawItems.forEach((item, index) => {
      const source = normalizeRequiredImageSource(
        item,
        rawItems.length > 1 ? `${label}[${index}]` : label,
      );
      const sourceType = inferGenericImageSourceType(source);
      const shouldNormalizeAsLocalPath = sourceType === "auto" && !isInlineSvgSource(source);
      const normalized = shouldNormalizeAsLocalPath
        ? normalizeImageLocalPathSource(
            source,
            rawItems.length > 1 ? `${label}[${index}]` : label,
            root,
            scopedWorkdir,
            rootExplicit,
          )
        : { source, root: undefined, workdir: undefined, scopedPath: undefined };
      sources.push({
        source: normalized.source,
        sourceType,
        mimeType,
        root: normalized.root,
        workdir: normalized.workdir,
        scopedPath: normalized.scopedPath,
      });
    });
  }

  function normalizeDisplayImageSources(
    args: any,
    root: FileToolRoot,
    scopedWorkdir: string,
    rootExplicit: boolean,
  ): DisplayImageSourceInput[] {
    const sources: DisplayImageSourceInput[] = [];
    const mimeType = getOptionalMimeType(args);

    if (Array.isArray(args?.sources) && args.sources.length > 0) {
      pushGenericImageSources(
        sources,
        args.sources,
        "Image.sources",
        mimeType,
        root,
        scopedWorkdir,
        rootExplicit,
      );
    } else if (typeof args?.source === "string" && args.source.trim()) {
      pushGenericImageSources(
        sources,
        [args.source],
        "Image.source",
        mimeType,
        root,
        scopedWorkdir,
        rootExplicit,
      );
    }

    if (Array.isArray(args?.paths) && args.paths.length > 0) {
      pushImageSources(
        sources,
        args.paths,
        "path",
        "Image.paths",
        undefined,
        root,
        scopedWorkdir,
        rootExplicit,
      );
    } else if (typeof args?.path === "string" && args.path.trim()) {
      pushImageSources(
        sources,
        [args.path],
        "path",
        "Image.path",
        undefined,
        root,
        scopedWorkdir,
        rootExplicit,
      );
    }

    if (Array.isArray(args?.urls) && args.urls.length > 0) {
      pushImageSources(sources, args.urls, "url", "Image.urls");
    } else if (typeof args?.url === "string" && args.url.trim()) {
      pushImageSources(sources, [args.url], "url", "Image.url");
    }

    if (Array.isArray(args?.base64s) && args.base64s.length > 0) {
      pushImageSources(sources, args.base64s, "base64", "Image.base64s", mimeType);
    } else if (typeof args?.base64 === "string" && args.base64.trim()) {
      pushImageSources(sources, [args.base64], "base64", "Image.base64", mimeType);
    }

    if (sources.length === 0) {
      throw new Error("Image requires path, paths, url, urls, base64, base64s, source, or sources");
    }
    if (sources.length > MAX_DISPLAY_IMAGE_PATHS) {
      throw new Error(`Image supports at most ${MAX_DISPLAY_IMAGE_PATHS} sources per call`);
    }
    return sources;
  }

  function normalizeProxyImageUrl(source: string) {
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch (error) {
      throw new Error(
        `Image.url must be an absolute URL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Image.url only supports http and https");
    }
    if (parsed.username || parsed.password) {
      throw new Error("Image.url cannot include embedded username or password");
    }
    return parsed.toString();
  }

  function buildProxyDisplayImage(input: DisplayImageSourceInput): DisplayImageEntry {
    const sourceUrl = normalizeProxyImageUrl(input.source);
    return {
      details: {
        path: sourceUrl,
        sourceType: "url",
        renderMode: "proxy",
        sourceUrl,
        mimeType: input.mimeType,
      },
    };
  }

  async function readDisplayImage(input: DisplayImageSourceInput): Promise<DisplayImageEntry> {
    if (input.sourceType === "url") {
      return buildProxyDisplayImage(input);
    }

    let res: ReadCommandResponse;
    try {
      res = await invoke<ReadCommandResponse>("fs_read_image_source", {
        workdir: input.workdir ?? workdir,
        source: input.source,
        source_type: input.sourceType,
        mime_type: input.mimeType,
      } as any);
    } catch (error) {
      if (!input.root) {
        throw new Error(
          [
            `Image failed for source="${input.source}": ${asErrorMessage(error)}`,
            'If this image is inside the workspace or installed Skills, retry with root="workspace" or root="skills" and a relative path.',
            "Do not use Bash, open, xdg-open, Markdown, HTML, or file:// URLs to display workspace or Skills images.",
          ].join(" "),
        );
      }
      throw new Error(
        buildScopedToolRuntimeError({
          toolName: "Image",
          root: input.root,
          path: input.scopedPath ?? (input.sourceType === "path" ? input.source : undefined),
          error,
        }),
      );
    }

    if (res.kind !== "image") {
      throw new Error(`${input.source} is not a supported image file`);
    }
    if (typeof res.data !== "string" || !res.data) {
      throw new Error(`Image did not return image bytes for ${input.source}`);
    }

    const mimeType = String(res.mimeType || "application/octet-stream");
    const displayPath = typeof res.path === "string" && res.path ? res.path : input.source;
    const sizeBytes = typeof res.sizeBytes === "number" ? res.sizeBytes : 0;
    return {
      content: {
        type: "image" as const,
        data: res.data,
        mimeType,
      },
      details: {
        ...(input.root === "skills" ? { root: input.root } : {}),
        path: displayPath,
        sourceType: input.sourceType,
        renderMode: "inline",
        mimeType,
        sizeBytes,
        mtimeMs: res.mtimeMs,
        contentHash: res.contentHash,
      },
    };
  }

  async function execImage(
    args: any,
    signal?: AbortSignal,
  ): Promise<ToolOk<DisplayImageResultDetails>> {
    if (signal?.aborted) throw new Error("Cancelled");

    const root = normalizeRoot(args, "Image");
    const scopedWorkdir = await resolveRootWorkdir(root);
    const rootExplicit = typeof args?.root === "string" && args.root.trim().length > 0;
    const sources = normalizeDisplayImageSources(args, root, scopedWorkdir, rootExplicit);
    const entries: DisplayImageEntry[] = [];
    for (const source of sources) {
      if (signal?.aborted) throw new Error("Cancelled");
      entries.push(await readDisplayImage(source));
    }

    const imageDetails = entries.map((entry) => entry.details);
    const firstImage = imageDetails[0];
    if (!firstImage) {
      throw new Error("Image requires at least one source");
    }
    const loadMode = imageDetails.every((image) => image.renderMode === "proxy")
      ? "proxy"
      : imageDetails.some((image) => image.renderMode === "proxy")
        ? "mixed"
        : "inline";
    const details: DisplayImageResultDetails = {
      kind: "display_image",
      images: imageDetails,
      loadMode,
      path: firstImage?.path,
      mimeType: firstImage?.mimeType,
      sizeBytes: firstImage?.sizeBytes,
      mtimeMs: firstImage?.mtimeMs,
      contentHash: firstImage?.contentHash,
    };
    const formatImagePath = (image: DisplayImageItemDetails) =>
      image.root && image.root !== "workspace"
        ? `root=${image.root} path=${image.path}`
        : image.path;
    const textSummary =
      imageDetails.length === 1
        ? [
            `Display image: ${formatImagePath(firstImage)}`,
            `sourceType=${firstImage.sourceType ?? "unknown"}`,
            `renderMode=${firstImage.renderMode ?? "inline"}`,
            firstImage.mimeType ? `mime=${firstImage.mimeType}` : null,
            typeof firstImage.sizeBytes === "number" ? `sizeBytes=${firstImage.sizeBytes}` : null,
          ]
            .filter(Boolean)
            .join("\n")
        : [
            `Display images: ${imageDetails.length}`,
            ...imageDetails.map((image, index) =>
              [
                `${index + 1}. ${formatImagePath(image)}`,
                `sourceType=${image.sourceType ?? "unknown"}`,
                `renderMode=${image.renderMode ?? "inline"}`,
                image.mimeType ? `mime=${image.mimeType}` : null,
                typeof image.sizeBytes === "number" ? `sizeBytes=${image.sizeBytes}` : null,
              ]
                .filter(Boolean)
                .join("\n"),
            ),
          ].join("\n");

    return {
      content: [
        {
          type: "text",
          text: textSummary,
        },
        ...entries.flatMap((entry) => (entry.content ? [entry.content] : [])),
      ],
      details,
    };
  }

  async function execWrite(args: any, signal?: AbortSignal): Promise<ToolOk<WriteResultDetails>> {
    if (signal?.aborted) throw new Error("Cancelled");

    const root = normalizeRoot(args, "Write");
    const scopedWorkdir = await resolveRootWorkdir(root);
    const path = normalizeRequiredScopedRelPath({
      input: args?.path,
      label: "Write.path",
      expectedRoot: root,
      workdir,
      skillsRootDir: cachedSkillsRootDir,
    });
    assertSkillsPathMutationAccess(root, path, 'Write(root="skills")');
    const content = typeof args?.content === "string" ? args.content : "";
    const mode = typeof args?.mode === "string" ? args.mode : "rewrite";
    if (mode !== "rewrite") {
      throw new Error("Write.mode only supports rewrite");
    }

    const latest = fileState.getLatest(path, root);
    if (latest?.kind === "text" && latest.isPartialView) {
      throw new Error(
        `Write requires a full-file Read first for existing files: ${formatScopedTarget(root, path)}. Retry with Read using the same root and path before rewriting. Do not use Bash for workspace or Skills file operations.`,
      );
    }
    const fullSnapshot = fileState.getLatestFullText(path, root);

    const res = await invokeScopedFileCommand<WriteCommandResponse>({
      toolName: "Write",
      root,
      path,
      command: "fs_write_text",
      args: {
        workdir: scopedWorkdir,
        path,
        content,
        mode: "rewrite",
        expected_mtime_ms: fullSnapshot?.mtimeMs,
        expected_content_hash: fullSnapshot?.contentHash,
      },
    });

    const details: WriteResultDetails = {
      kind: "write",
      root,
      path,
      mode: "rewrite",
      existedBefore: Boolean(res.existedBefore),
      bytesWritten: res.bytesWritten,
      mtimeMs: res.mtimeMs,
      contentHash: res.contentHash,
      totalLines: res.totalLines,
      preview: previewSnippet(content),
    };
    fileState.recordTextMutation({
      root,
      path,
      mtimeMs: res.mtimeMs,
      contentHash: res.contentHash,
      totalLines: res.totalLines,
    });

    return {
      content: [
        {
          type: "text",
          text:
            `Write: ${formatScopedTarget(root, path)}\n` +
            `mode=rewrite\n` +
            `target=${details.existedBefore ? "existing" : "new"}\n` +
            `bytesWritten=${details.bytesWritten}`,
        },
      ],
      details,
    };
  }

  async function execEdit(args: any, signal?: AbortSignal): Promise<ToolOk<EditResultDetails>> {
    if (signal?.aborted) throw new Error("Cancelled");

    const root = normalizeRoot(args, "Edit");
    const scopedWorkdir = await resolveRootWorkdir(root);
    const path = normalizeRequiredScopedRelPath({
      input: args?.path,
      label: "Edit.path",
      expectedRoot: root,
      workdir,
      skillsRootDir: cachedSkillsRootDir,
    });
    assertSkillsPathMutationAccess(root, path, 'Edit(root="skills")');
    const old_string = typeof args?.old_string === "string" ? args.old_string : "";
    const new_string = typeof args?.new_string === "string" ? args.new_string : "";
    const expected_replacements =
      typeof args?.expected_replacements === "number" ? args.expected_replacements : undefined;
    const replace_all = args?.replace_all === true;

    if (!old_string) {
      throw new Error("Edit.old_string must be a non-empty string");
    }

    const { snapshot, autoRead } = await primeFullTextSnapshotForEdit({
      root,
      path,
      signal,
    });

    const res = await invokeScopedFileCommand<EditCommandResponse>({
      toolName: "Edit",
      root,
      path,
      command: "fs_edit_text",
      args: {
        workdir: scopedWorkdir,
        path,
        old_string,
        new_string,
        expected_replacements,
        replace_all,
        expected_mtime_ms: snapshot.mtimeMs,
        expected_content_hash: snapshot.contentHash,
      },
    });

    const details: EditResultDetails = {
      kind: "edit",
      root,
      path,
      replacements: res.replacements,
      replaceAll: res.replaceAll,
      expectedReplacements: expected_replacements,
      mtimeMs: res.mtimeMs,
      contentHash: res.contentHash,
      totalLines: res.totalLines,
      oldPreview: previewSnippet(old_string),
      newPreview: previewSnippet(new_string),
    };
    fileState.recordTextMutation({
      root,
      path,
      mtimeMs: res.mtimeMs,
      contentHash: res.contentHash,
      totalLines: res.totalLines,
    });

    return {
      content: [
        {
          type: "text",
          text:
            `Edit: ${formatScopedTarget(root, path)}\n` +
            `replacements=${details.replacements}\n` +
            `replaceAll=${details.replaceAll}` +
            (autoRead ? "\nautoRead=full" : ""),
        },
      ],
      details,
    };
  }

  async function execDelete(args: any, signal?: AbortSignal): Promise<ToolOk<DeleteResultDetails>> {
    if (signal?.aborted) throw new Error("Cancelled");

    const root = normalizeRoot(args, "Delete");
    const scopedWorkdir = await resolveRootWorkdir(root);
    const path = normalizeRequiredScopedRelPath({
      input: args?.path,
      label: "Delete.path",
      expectedRoot: root,
      workdir,
      skillsRootDir: cachedSkillsRootDir,
    });
    assertSkillsPathMutationAccess(root, path, 'Delete(root="skills")');
    const res = await invokeScopedFileCommand<DeleteCommandResponse>({
      toolName: "Delete",
      root,
      path,
      command: "fs_delete",
      args: {
        workdir: scopedWorkdir,
        path,
      },
    });
    fileState.clear(path, root);

    return {
      content: [
        {
          type: "text",
          text: `Delete: ${formatScopedTarget(root, path)}\nkind=${res.kind}`,
        },
      ],
      details: {
        kind: "delete",
        root,
        path,
        targetKind: res.kind,
      },
    };
  }

  async function execList(args: any, signal?: AbortSignal): Promise<ToolOk<ListResultDetails>> {
    if (signal?.aborted) throw new Error("Cancelled");

    const root = normalizeRoot(args, "List");
    const scopedWorkdir = await resolveRootWorkdir(root);
    const pathArg = args?.path;
    const path =
      typeof pathArg === "string"
        ? normalizeOptionalScopedRelPath({
            input: pathArg,
            label: "List.path",
            expectedRoot: root,
            workdir,
            skillsRootDir: cachedSkillsRootDir,
          })
        : undefined;
    assertOptionalSkillsPathAccess(root, path, 'List(root="skills")');
    const depth = typeof args?.depth === "number" ? args.depth : undefined;
    const offset = typeof args?.offset === "number" ? args.offset : undefined;
    const max_results = typeof args?.max_results === "number" ? args.max_results : undefined;

    const res = await invokeScopedFileCommand<ListCommandResponse>({
      toolName: "List",
      root,
      path,
      command: "fs_list",
      args: {
        workdir: scopedWorkdir,
        path,
        depth,
        offset,
        max_results,
      },
    });

    const details: ListResultDetails = {
      kind: "list",
      root,
      path: res.path ?? undefined,
      depth: res.depth,
      offset: res.offset,
      maxResults: res.maxResults,
      total: res.total,
      hasMore: res.hasMore,
      entries: res.entries,
    };

    const lines = res.entries.map(
      (entry) => `${entry.kind === "dir" ? "[DIR]" : "[FILE]"} ${entry.path}`,
    );
    const suffix = res.hasMore ? "\n...more entries omitted...\n" : "";

    return {
      content: [
        {
          type: "text",
          text:
            `List: ${formatScopedTarget(root, path)}\n` +
            `offset=${details.offset} total=${details.total}\n` +
            `${lines.join("\n")}${suffix}`,
        },
      ],
      details,
    };
  }

  async function execGlob(args: any, signal?: AbortSignal): Promise<ToolOk<GlobResultDetails>> {
    if (signal?.aborted) throw new Error("Cancelled");

    const root = normalizeRoot(args, "Glob");
    const scopedWorkdir = await resolveRootWorkdir(root);
    const pattern = typeof args?.pattern === "string" ? args.pattern.trim() : "";
    if (!pattern) throw new Error("Glob.pattern is required");

    const pathArg = args?.path;
    const path =
      typeof pathArg === "string"
        ? normalizeOptionalScopedRelPath({
            input: pathArg,
            label: "Glob.path",
            expectedRoot: root,
            workdir,
            skillsRootDir: cachedSkillsRootDir,
          })
        : undefined;
    if (root === "skills") {
      if (path) {
        assertSkillPathAllowedByPolicy(skillAccessPolicy, path, 'Glob(root="skills")');
      } else {
        assertSkillPathAllowedByPolicy(skillAccessPolicy, pattern, 'Glob(root="skills")');
      }
    }
    const offset = typeof args?.offset === "number" ? args.offset : undefined;
    const max_results = typeof args?.max_results === "number" ? args.max_results : undefined;
    const sort_by = typeof args?.sort_by === "string" ? args.sort_by : undefined;
    if (sort_by && sort_by !== "path") {
      throw new Error("Glob.sort_by only supports path");
    }

    const res = await invokeScopedFileCommand<GlobCommandResponse>({
      toolName: "Glob",
      root,
      path,
      command: "fs_glob",
      args: {
        workdir: scopedWorkdir,
        path,
        pattern,
        offset,
        max_results,
        sort_by,
      },
    });

    const details: GlobResultDetails = {
      kind: "glob",
      root,
      path: res.path ?? undefined,
      pattern: res.pattern,
      sortBy: res.sortBy,
      offset: res.offset,
      maxResults: res.maxResults,
      total: res.total,
      hasMore: res.hasMore,
      paths: res.paths,
    };
    const suffix = res.hasMore ? "\n...more matches omitted...\n" : "";

    return {
      content: [
        {
          type: "text",
          text:
            `Glob: ${pattern}\n` +
            `${formatScopedTarget(root, path)} offset=${details.offset} total=${details.total}\n` +
            `${res.paths.join("\n")}${suffix}`,
        },
      ],
      details,
    };
  }

  async function execGrep(args: any, signal?: AbortSignal): Promise<ToolOk<GrepResultDetails>> {
    if (signal?.aborted) throw new Error("Cancelled");

    const root = normalizeRoot(args, "Grep");
    const scopedWorkdir = await resolveRootWorkdir(root);
    const pattern = typeof args?.pattern === "string" ? args.pattern : "";
    if (!pattern.trim()) throw new Error("Grep.pattern is required");

    const pathArg = args?.path;
    let path =
      typeof pathArg === "string"
        ? normalizeOptionalScopedRelPath({
            input: pathArg,
            label: "Grep.path",
            expectedRoot: root,
            workdir,
            skillsRootDir: cachedSkillsRootDir,
          })
        : undefined;
    assertOptionalSkillsPathAccess(root, path, 'Grep(root="skills")');
    const file_pattern =
      typeof args?.file_pattern === "string" ? args.file_pattern.trim() : undefined;
    const ignore_case = typeof args?.ignore_case === "boolean" ? args.ignore_case : true;
    const output_mode =
      args?.output_mode === "files" || args?.output_mode === "count" ? args.output_mode : "content";
    const head_limit = typeof args?.head_limit === "number" ? args.head_limit : undefined;
    const offset = typeof args?.offset === "number" ? args.offset : undefined;
    const context = typeof args?.context === "number" ? args.context : undefined;
    const multiline = args?.multiline === true;

    let effectiveFilePattern = file_pattern;
    let correctedFilePath: string | undefined;
    let res: GrepCommandResponse;
    try {
      res = await invokeScopedFileCommand<GrepCommandResponse>({
        toolName: "Grep",
        root,
        path,
        command: "fs_grep",
        args: {
          workdir: scopedWorkdir,
          path,
          pattern,
          file_pattern: effectiveFilePattern,
          ignore_case,
          output_mode,
          head_limit,
          offset,
          context,
          multiline,
        },
      });
    } catch (error) {
      if (!path || !/Grep\.path must be a directory/.test(asErrorMessage(error))) {
        throw error;
      }
      const split = splitRelativeFilePath(path);
      if (!split.fileName) {
        throw error;
      }
      correctedFilePath = path;
      path = split.parentPath;
      effectiveFilePattern = split.fileName;
      assertOptionalSkillsPathAccess(root, path, 'Grep(root="skills")');
      res = await invokeScopedFileCommand<GrepCommandResponse>({
        toolName: "Grep",
        root,
        path,
        command: "fs_grep",
        args: {
          workdir: scopedWorkdir,
          path,
          pattern,
          file_pattern: effectiveFilePattern,
          ignore_case,
          output_mode,
          head_limit,
          offset,
          context,
          multiline,
        },
      });
    }

    const details: GrepResultDetails = {
      kind: "grep",
      root,
      path: res.path ?? undefined,
      pattern: res.pattern,
      filePattern: res.filePattern ?? undefined,
      ignoreCase: res.ignoreCase,
      outputMode: res.outputMode,
      headLimit: res.headLimit,
      offset: res.offset,
      context: res.context,
      multiline: res.multiline,
      matchCount: res.matchCount,
      fileCount: res.fileCount,
      hasMore: res.hasMore,
      matches: res.matches,
      files: res.files.map((file) => ({
        path: file.path,
        count: file.count,
        firstLine: typeof file.firstLine === "number" ? file.firstLine : undefined,
      })),
    };

    const body =
      res.outputMode === "count"
        ? `matches=${res.matchCount}\nfiles=${res.fileCount}`
        : res.outputMode === "files"
          ? res.files
              .map(
                (file) =>
                  `${file.path} (${file.count}${typeof file.firstLine === "number" ? `, firstLine=${file.firstLine}` : ""})`,
              )
              .join("\n")
          : res.matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n");
    const suffix = res.hasMore ? "\n...more results omitted...\n" : "";

    return {
      content: [
        {
          type: "text",
          text:
            `Grep: ${pattern}\n` +
            `${formatScopedTarget(root, path)}\n` +
            (correctedFilePath
              ? `autoCorrectedPath=${correctedFilePath} file_pattern=${effectiveFilePattern}\n`
              : "") +
            `mode=${res.outputMode} matches=${res.matchCount} files=${res.fileCount}\n` +
            `${body}${suffix}`,
        },
      ],
      details,
    };
  }

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const now = Date.now();
    if (!workdir.trim()) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "Working directory is not configured; cannot run tools." }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    try {
      let result: ToolOk;
      switch (toolCall.name) {
        case "Read":
          result = await execRead(toolCall.arguments, signal);
          break;
        case "Image":
          result = await execImage(toolCall.arguments, signal);
          break;
        case "Write":
          result = await execWrite(toolCall.arguments, signal);
          break;
        case "Edit":
          result = await execEdit(toolCall.arguments, signal);
          break;
        case "Delete":
          result = await execDelete(toolCall.arguments, signal);
          break;
        case "List":
          result = await execList(toolCall.arguments, signal);
          break;
        case "Glob":
          result = await execGlob(toolCall.arguments, signal);
          break;
        case "Grep":
          result = await execGrep(toolCall.arguments, signal);
          break;
        default:
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

      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: result.content,
        details: result.details,
        isError: false,
        timestamp: now,
      };
    } catch (err) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: asErrorMessage(err) }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }
  }

  return {
    groupId: "fs",
    tools,
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        "Read",
        {
          groupId: "fs",
          kind: "read",
          isReadOnly: true,
          displayCategory: "file",
        },
      ],
      [
        "Image",
        {
          groupId: "fs",
          kind: "display_image",
          isReadOnly: true,
          displayCategory: "file",
        },
      ],
      [
        "Write",
        {
          groupId: "fs",
          kind: "write",
          isReadOnly: false,
          displayCategory: "file",
        },
      ],
      [
        "Edit",
        {
          groupId: "fs",
          kind: "edit",
          isReadOnly: false,
          displayCategory: "file",
        },
      ],
      [
        "Delete",
        {
          groupId: "fs",
          kind: "delete",
          isReadOnly: false,
          displayCategory: "file",
        },
      ],
      [
        "List",
        {
          groupId: "fs",
          kind: "list",
          isReadOnly: true,
          displayCategory: "search",
        },
      ],
      [
        "Glob",
        {
          groupId: "fs",
          kind: "glob",
          isReadOnly: true,
          displayCategory: "search",
        },
      ],
      [
        "Grep",
        {
          groupId: "fs",
          kind: "grep",
          isReadOnly: true,
          displayCategory: "search",
        },
      ],
    ]),
  };
}
