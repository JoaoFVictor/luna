import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

const OPERATIONAL_ENVIRONMENT_VARIABLES = new Set<string>(["PATH", "HOME"]);

function validationEnvironment(
  allowlist: readonly string[],
  source: NodeJS.ProcessEnv,
  isolatedHome: string
): NodeJS.ProcessEnv {
  const entries: [string, string][] = [];
  if (source.PATH !== undefined) entries.push(["PATH", source.PATH]);
  entries.push(["HOME", isolatedHome]);

  for (const name of new Set(allowlist)) {
    if (OPERATIONAL_ENVIRONMENT_VARIABLES.has(name)) continue;
    const value = source[name];
    if (value !== undefined) entries.push([name, value]);
  }

  return Object.fromEntries(entries);
}

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
  envAllowlist,
  maxOutputBytes,
  sourceEnvironment = process.env,
  runProcess = defaultProcessRunner
}: {
  cwd: string;
  commands: readonly ValidationCommand[];
  envAllowlist: readonly string[];
  maxOutputBytes: number;
  sourceEnvironment?: NodeJS.ProcessEnv;
  runProcess?: ProcessRunner;
}): Promise<ValidationCommandsResult> {
  if (commands.length === 0) {
    return { passed: true, commands: [] };
  }

  const results: ValidationCommandResult[] = [];
  const isolatedHome = await mkdtemp(
    path.join(tmpdir(), "luna-validation-home-")
  );
  const env = validationEnvironment(
    envAllowlist,
    sourceEnvironment,
    isolatedHome
  );

  try {
    for (const command of commands) {
      const args = command.args ?? [];
      const result = await runProcess({
        cmd: command.cmd,
        args,
        cwd,
        env,
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
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
}
