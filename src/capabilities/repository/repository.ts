import { runGit } from "../git/client.js";
import type {
  AnyLunaToolDefinition,
  LunaToolDefinition,
  LunaToolDependencies
} from "../../core/tools/contracts.js";
import {
  repositoryDeleteFileToolContract,
  repositoryDiffSummaryToolContract,
  repositoryReadFileToolContract,
  repositoryStatusToolContract,
  repositoryWriteFileToolContract
} from "./repository-contracts.js";
import {
  deleteSecureRepositoryFile,
  readSecureRepositoryFile,
  writeSecureRepositoryFile
} from "./repository-file-operations.js";

type EmptyInput = Record<string, never>;
type RepositoryToolDefinition = LunaToolDefinition<EmptyInput, string>;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;

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
    const maxBytes = Math.min(input.max_bytes ?? DEFAULT_MAX_FILE_BYTES, MAX_FILE_BYTES);
    const file = await readSecureRepositoryFile({
      cwd: dependencies.cwd,
      requestedPath: input.path,
      maxBytes
    });

    return {
      path: input.path,
      content: file.content.toString("utf8"),
      bytes: file.size,
      truncated: file.size > file.content.byteLength
    };
  }
};

export const repositoryWriteFileTool: LunaToolDefinition<
  RepositoryWriteFileInput,
  RepositoryWriteFileOutput
> = {
  ...repositoryWriteFileToolContract,
  createHandler: (dependencies) => async (input) => {
    await writeSecureRepositoryFile({
      cwd: dependencies.cwd,
      requestedPath: input.path,
      content: input.content,
      createDirectories: input.create_dirs === true
    });

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
    try {
      await deleteSecureRepositoryFile({
        cwd: dependencies.cwd,
        requestedPath: input.path
      });
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
