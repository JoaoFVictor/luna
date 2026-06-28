import {
  defaultProcessRunner,
  type ProcessRunner
} from "../local-exec/process-runner.js";
export {
  ValidationCommandResultSchema,
  ValidationCommandSchema,
  ValidationResultSchema,
  type ValidationCommand,
  type ValidationCommandResult,
  type ValidationResult
} from "../../core/validation/types.js";
import type {
  ValidationCommand,
  ValidationCommandResult,
  ValidationResult
} from "../../core/validation/types.js";

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
      timeoutMs: command.timeout_ms,
      maxOutputBytes
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
