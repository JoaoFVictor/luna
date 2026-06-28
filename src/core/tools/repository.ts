import { mkdir, open, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runGit } from "../git/client.js";
import type {
  AnyLunaToolDefinition,
  LunaToolDefinition,
  LunaToolDependencies
} from "./contracts.js";
import {
  repositoryDeleteFileToolContract,
  repositoryDiffSummaryToolContract,
  repositoryReadFileToolContract,
  repositoryStatusToolContract,
  repositoryWriteFileToolContract
} from "./repository-contracts.js";

type EmptyInput = Record<string, never>;
type RepositoryToolDefinition = LunaToolDefinition<EmptyInput, string>;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024;

type RepositoryReadFileInput = {
  readonly path: string;
  readonly max_bytes?: number;
};

type RepositoryWriteFileInput = {
  readonly path: string;
  readonly content: string;
  readonly create_dirs?: boolean;
};

type RepositoryDeleteFileInput = {
  readonly path: string;
  readonly missing_ok?: boolean;
};

type RepositoryReadFileOutput = {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
};

type RepositoryWriteFileOutput = {
  path: string;
  bytes: number;
};

type RepositoryDeleteFileOutput = {
  path: string;
  deleted: boolean;
};

function repositoryToolError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function safePath(cwd: string, requestedPath: string): string {
  if (path.isAbsolute(requestedPath)) {
    throw repositoryToolError(
      "Repository tool paths must be relative to the bound worktree.",
      "repository_tool_path_escape"
    );
  }

  const root = path.resolve(cwd);
  const resolved = path.resolve(root, requestedPath);
  const relative = path.relative(root, resolved);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }

  throw repositoryToolError(
    "Repository tool path escaped the bound worktree.",
    "repository_tool_path_escape"
  );
}

async function readBoundedFile(
  absolutePath: string,
  maxBytes: number
): Promise<{ content: string; bytes: number; truncated: boolean }> {
  const file = await open(absolutePath, "r");
  try {
    const stats = await file.stat();
    const buffer = Buffer.alloc(Math.min(stats.size, maxBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);

    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      bytes: stats.size,
      truncated: stats.size > maxBytes
    };
  } finally {
    await file.close();
  }
}

function repositoryHandler(
  dependencies: LunaToolDependencies,
  args: readonly string[]
): () => Promise<string> {
  return async () => await runGit(dependencies.cwd, args);
}

export const repositoryStatusTool: RepositoryToolDefinition = {
  ...repositoryStatusToolContract,
  createHandler: (dependencies) =>
    repositoryHandler(dependencies, ["status", "--short"])
};

export const repositoryDiffSummaryTool: RepositoryToolDefinition = {
  ...repositoryDiffSummaryToolContract,
  createHandler: (dependencies) =>
    repositoryHandler(dependencies, ["diff", "--stat"])
};

export const repositoryReadFileTool: LunaToolDefinition<
  RepositoryReadFileInput,
  RepositoryReadFileOutput
> = {
  ...repositoryReadFileToolContract,
  createHandler: (dependencies) => async (input) => {
    const maxBytes = input.max_bytes ?? DEFAULT_MAX_FILE_BYTES;
    const file = await readBoundedFile(safePath(dependencies.cwd, input.path), maxBytes);

    return {
      path: input.path,
      content: file.content,
      bytes: file.bytes,
      truncated: file.truncated
    };
  }
};

export const repositoryWriteFileTool: LunaToolDefinition<
  RepositoryWriteFileInput,
  RepositoryWriteFileOutput
> = {
  ...repositoryWriteFileToolContract,
  createHandler: (dependencies) => async (input) => {
    const absolutePath = safePath(dependencies.cwd, input.path);
    if (input.create_dirs === true) {
      await mkdir(path.dirname(absolutePath), { recursive: true });
    }
    await writeFile(absolutePath, input.content, "utf8");

    return {
      path: input.path,
      bytes: Buffer.byteLength(input.content, "utf8")
    };
  }
};

export const repositoryDeleteFileTool: LunaToolDefinition<
  RepositoryDeleteFileInput,
  RepositoryDeleteFileOutput
> = {
  ...repositoryDeleteFileToolContract,
  createHandler: (dependencies) => async (input) => {
    const absolutePath = safePath(dependencies.cwd, input.path);
    try {
      await unlink(absolutePath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT" && input.missing_ok === true) {
        return {
          path: input.path,
          deleted: false
        };
      }

      throw cause;
    }

    return {
      path: input.path,
      deleted: true
    };
  }
};

export const repositoryLocalTools = {
  [repositoryStatusTool.id]: repositoryStatusTool,
  [repositoryDiffSummaryTool.id]: repositoryDiffSummaryTool,
  [repositoryReadFileTool.id]: repositoryReadFileTool,
  [repositoryWriteFileTool.id]: repositoryWriteFileTool,
  [repositoryDeleteFileTool.id]: repositoryDeleteFileTool
} satisfies Record<string, AnyLunaToolDefinition>;
