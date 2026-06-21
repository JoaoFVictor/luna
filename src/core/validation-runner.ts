import { spawn } from "node:child_process";
import type {
  ValidationCommand
} from "./types.js";
import type {
  ValidationCommandResult,
  ValidationResult
} from "./agent-runtime/contracts.js";

export type ProcessRunRequest = {
  cmd: string;
  args: readonly string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
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

export const defaultProcessRunner: ProcessRunner = async ({
  cmd,
  args,
  cwd,
  timeoutMs,
  maxOutputBytes
}) => {
  const start = Date.now();
  const captureLimitBytes =
    maxOutputBytes === undefined ? undefined : Math.max(0, maxOutputBytes + 1);

  function createCollector(): {
    collect: (chunk: Buffer) => void;
    value: () => string;
  } {
    const chunks: Buffer[] = [];
    let capturedBytes = 0;

    return {
      collect: (chunk) => {
        const remaining =
          captureLimitBytes === undefined
            ? chunk.byteLength
            : captureLimitBytes - capturedBytes;

        if (remaining <= 0) {
          return;
        }

        const captured =
          chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        chunks.push(captured);
        capturedBytes += captured.byteLength;
      },
      value: () => Buffer.concat(chunks).toString("utf8")
    };
  }

  const stdout = createCollector();
  const stderr = createCollector();

  return await new Promise<ProcessRunResult>((resolve) => {
    let timedOut = false;
    let settled = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    let closeCode: number | null | undefined;
    const child = spawn(cmd, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs);

    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timeout !== undefined) {
        clearTimeout(timeout);
      }

      resolve({
        exitCode,
        stdout: stdout.value(),
        stderr: stderr.value(),
        timedOut,
        durationMs: Date.now() - start
      });
    };

    const finishIfComplete = () => {
      if (
        closeCode !== undefined &&
        stdoutEnded &&
        stderrEnded
      ) {
        finish(closeCode);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.collect(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.collect(chunk));
    child.stdout.on("end", () => {
      stdoutEnded = true;
      finishIfComplete();
    });
    child.stderr.on("end", () => {
      stderrEnded = true;
      finishIfComplete();
    });

    child.on("error", () => finish(null));
    child.on("close", (code) => {
      closeCode = code;
      finishIfComplete();
    });
  });
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
