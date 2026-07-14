import { spawn } from "node:child_process";

export type ProcessRunRequest = {
  cmd: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
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

export const defaultProcessRunner: ProcessRunner = async ({
  cmd,
  args,
  cwd,
  env,
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
    const child = spawn(cmd, [...args], {
      cwd,
      ...(env === undefined ? {} : { env }),
      stdio: ["ignore", "pipe", "pipe"]
    });
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
