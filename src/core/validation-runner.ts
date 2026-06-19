import { execFile } from "node:child_process";
import type {
  ValidationCommand,
  ValidationCommandResult,
  ValidationResult
} from "./types.js";

export type ProcessRunRequest = {
  cmd: string;
  args: readonly string[];
  cwd: string;
  timeoutMs?: number;
};

export type ProcessRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export type ProcessRunner = (
  request: ProcessRunRequest
) => Promise<ProcessRunResult>;

export type ValidationCommandsResult = ValidationResult & {
  commands: ValidationCommandResult[];
};

function truncateBytes(
  value: string,
  maxBytes: number
): { value: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value, "utf8");

  if (bytes <= maxBytes) {
    return { value, truncated: false };
  }

  return {
    value: Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8"),
    truncated: true
  };
}

function errorExitCode(error: unknown): number | null {
  const code = (error as { code?: unknown }).code;

  return typeof code === "number" ? code : null;
}

function errorOutput(error: unknown, stream: "stdout" | "stderr"): string {
  const output = (error as { [key in typeof stream]?: unknown })[stream];

  return typeof output === "string" ? output : "";
}

function errorTimedOut(error: unknown): boolean {
  const maybeError = error as { killed?: unknown; signal?: unknown };

  return maybeError.killed === true && maybeError.signal === "SIGTERM";
}

export const defaultProcessRunner: ProcessRunner = async ({
  cmd,
  args,
  cwd,
  timeoutMs
}) => {
  const start = Date.now();

  try {
    const result = await new Promise<{
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      execFile(
        cmd,
        [...args],
        { cwd, timeout: timeoutMs, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error !== null) {
            Object.assign(error, { stdout, stderr });
            reject(error);
            return;
          }

          resolve({ stdout, stderr });
        }
      );
    });

    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: false,
      durationMs: Date.now() - start
    };
  } catch (error) {
    return {
      exitCode: errorExitCode(error),
      stdout: errorOutput(error, "stdout"),
      stderr: errorOutput(error, "stderr"),
      timedOut: errorTimedOut(error),
      durationMs: Date.now() - start
    };
  }
};

export async function runValidationCommands({
  cwd,
  commands,
  maxOutputBytes,
  runProcess = defaultProcessRunner
}: {
  cwd: string;
  commands: readonly ValidationCommand[];
  maxOutputBytes: number;
  runProcess?: ProcessRunner;
}): Promise<ValidationCommandsResult> {
  const results: ValidationCommandResult[] = [];

  for (const command of commands) {
    const args = command.args ?? [];
    const result = await runProcess({
      cmd: command.cmd,
      args,
      cwd,
      timeoutMs: command.timeout_ms
    });
    const stdout = truncateBytes(result.stdout, maxOutputBytes);
    const stderr = truncateBytes(result.stderr, maxOutputBytes);

    results.push({
      cmd: command.cmd,
      args: command.args,
      exit_code: result.exitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
      duration_ms: result.durationMs,
      timed_out: result.timedOut
    });
  }

  return {
    passed: results.every(
      (result) => result.exit_code === 0 && !result.timed_out
    ),
    commands: results
  };
}
