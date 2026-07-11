import {
  BoundedProcessError,
  runBoundedProcess
} from "../../../core/process/bounded-process.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;

const READ_ONLY_GIT_GLOBAL_ARGS = [
  "--no-pager",
  "--no-replace-objects",
  "--literal-pathspecs",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "core.attributesFile=/dev/null"
] as const;

export type StudioGitReadRequest = {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly stdin?: Uint8Array;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly acceptedExitCodes?: readonly number[];
};

export type StudioGitReadResult = {
  readonly stdout: Buffer;
  readonly exitCode: number;
};

export type StudioGitReadRunner = (
  request: StudioGitReadRequest
) => Promise<StudioGitReadResult>;

export type StudioGitProcessFailureReason = BoundedProcessError["reason"];

export class StudioGitProcessError extends Error {
  readonly reason: StudioGitProcessFailureReason;
  readonly exitCode?: number;

  constructor(
    reason: StudioGitProcessFailureReason,
    options: { readonly exitCode?: number; readonly cause?: unknown } = {}
  ) {
    super("The read-only Git operation failed", { cause: options.cause });
    this.name = "StudioGitProcessError";
    this.reason = reason;
    this.exitCode = options.exitCode;
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat"
  };
}

export const runStudioGitRead: StudioGitReadRunner = async (request) => {
  try {
    return await runBoundedProcess({
      command: "git",
      args: [...READ_ONLY_GIT_GLOBAL_ARGS, ...request.args],
      cwd: request.cwd,
      env: gitEnvironment(),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxStdoutBytes: request.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
      maxStderrBytes: request.maxStderrBytes ?? MAX_STDERR_BYTES,
      maxStdinBytes: MAX_STDIN_BYTES,
      ...(request.acceptedExitCodes === undefined
        ? {}
        : { acceptedExitCodes: request.acceptedExitCodes })
    });
  } catch (cause) {
    if (cause instanceof BoundedProcessError) {
      throw new StudioGitProcessError(cause.reason, {
        ...(cause.exitCode === undefined ? {} : { exitCode: cause.exitCode }),
        cause
      });
    }
    throw cause;
  }
};
