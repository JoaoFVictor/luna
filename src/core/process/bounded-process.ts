import { spawn } from "node:child_process";

const KILL_GRACE_MS = 250;

export type BoundedProcessFailureReason =
  | "spawn_failed"
  | "aborted"
  | "timed_out"
  | "stdout_too_large"
  | "stderr_too_large"
  | "stdin_too_large"
  | "command_failed";

export class BoundedProcessError extends Error {
  readonly reason: BoundedProcessFailureReason;
  readonly exitCode?: number;

  constructor(
    reason: BoundedProcessFailureReason,
    options: { readonly exitCode?: number; readonly cause?: unknown } = {}
  ) {
    super("The bounded process failed", { cause: options.cause });
    this.name = "BoundedProcessError";
    this.reason = reason;
    this.exitCode = options.exitCode;
  }
}

export type BoundedProcessRequest = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly stdin?: Uint8Array;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxStdinBytes: number;
  readonly acceptedExitCodes?: readonly number[];
};

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function terminateProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals
): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The process group may already have exited.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The direct process may already have exited.
  }
}

export async function runBoundedProcess(
  request: BoundedProcessRequest
): Promise<{ readonly stdout: Buffer; readonly exitCode: number }> {
  const timeoutMs = positiveSafeInteger(request.timeoutMs, "Process timeout");
  const maxStdoutBytes = positiveSafeInteger(
    request.maxStdoutBytes,
    "Process stdout limit"
  );
  const maxStderrBytes = positiveSafeInteger(
    request.maxStderrBytes,
    "Process stderr limit"
  );
  const maxStdinBytes = positiveSafeInteger(
    request.maxStdinBytes,
    "Process stdin limit"
  );
  if (request.signal?.aborted === true) {
    throw new BoundedProcessError("aborted");
  }
  const stdin = Buffer.from(request.stdin ?? []);
  if (stdin.byteLength > maxStdinBytes) {
    throw new BoundedProcessError("stdin_too_large");
  }
  const acceptedExitCodes = new Set(request.acceptedExitCodes ?? [0]);
  if (
    acceptedExitCodes.size === 0 ||
    [...acceptedExitCodes].some(
      (code) => !Number.isSafeInteger(code) || code < 0 || code > 255
    )
  ) {
    throw new TypeError("Accepted process exit codes are invalid");
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: BoundedProcessFailureReason | undefined;
    let settled = false;
    let hardKill: NodeJS.Timeout | undefined;

    const failAndTerminate = (reason: BoundedProcessFailureReason) => {
      if (failure !== undefined) return;
      failure = reason;
      terminateProcessGroup(child, "SIGTERM");
      hardKill = setTimeout(
        () => terminateProcessGroup(child, "SIGKILL"),
        KILL_GRACE_MS
      );
      hardKill.unref();
    };
    const abort = () => failAndTerminate("aborted");
    const timeout = setTimeout(
      () => failAndTerminate("timed_out"),
      timeoutMs
    );
    timeout.unref();

    const finish = (
      outcome:
        | { readonly stdout: Buffer; readonly exitCode: number }
        | { readonly error: BoundedProcessError }
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (hardKill !== undefined) clearTimeout(hardKill);
      request.signal?.removeEventListener("abort", abort);
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome);
    };

    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted === true) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        failAndTerminate("stdout_too_large");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxStderrBytes) {
        failAndTerminate("stderr_too_large");
      }
    });
    child.once("error", (cause) => {
      finish({ error: new BoundedProcessError("spawn_failed", { cause }) });
    });
    child.once("close", (exitCode) => {
      if (failure !== undefined) {
        finish({ error: new BoundedProcessError(failure) });
        return;
      }
      if (exitCode === null || !acceptedExitCodes.has(exitCode)) {
        finish({
          error: new BoundedProcessError("command_failed", {
            ...(exitCode === null ? {} : { exitCode })
          })
        });
        return;
      }
      finish({
        stdout: Buffer.concat(stdout, stdoutBytes),
        exitCode
      });
    });
    child.stdin.on("error", () => {
      // The exit status remains authoritative if a command closes stdin early.
    });
    child.stdin.end(stdin);
  });
}
