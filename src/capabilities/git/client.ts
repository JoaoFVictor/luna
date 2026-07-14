import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { codeForArgs, gitError } from "./errors.js";

const execFileAsync = promisify(execFile);

export async function runGit(
  cwd: string,
  args: readonly string[],
  timeoutMs = 60000
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      timeout: timeoutMs
    });

    return stdout;
  } catch (cause) {
    throw gitError(
      `Git command failed: git ${args.join(" ")}`,
      codeForArgs(args),
      cause
    );
  }
}

export type BoundedGitOutput = {
  readonly stdout: string;
  readonly truncated: boolean;
};

export async function runGitBounded(
  cwd: string,
  args: readonly string[],
  maxOutputBytes: number,
  timeoutMs = 60_000,
  signal?: AbortSignal
): Promise<BoundedGitOutput> {
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new TypeError("maxOutputBytes must be a positive integer");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  return await new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn("git", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let retainedBytes = 0;
    let errorBytes = 0;
    let truncated = false;
    let terminatedForOverflow = false;
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = Math.max(0, maxOutputBytes - retainedBytes);
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        chunks.push(retained);
        retainedBytes += retained.length;
      }
      if (chunk.length > remaining) {
        truncated = true;
        terminatedForOverflow = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = Math.max(0, 64 * 1024 - errorBytes);
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        errors.push(retained);
        errorBytes += retained.length;
      }
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(gitError(
        `Git command failed: git ${args.join(" ")}`,
        codeForArgs(args),
        cause
      ));
    });
    child.on("close", (code, childSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted === true) {
        reject(signal.reason ?? new DOMException("Git command aborted", "AbortError"));
        return;
      }
      if (code !== 0 && !terminatedForOverflow) {
        reject(gitError(
          `Git command failed: git ${args.join(" ")}`,
          codeForArgs(args),
          new Error(Buffer.concat(errors).toString("utf8") ||
            `git exited with ${code ?? childSignal ?? "unknown status"}`)
        ));
        return;
      }
      const decoded = Buffer.concat(chunks).toString("utf8");
      let bytesUsed = 0;
      let stdout = "";
      for (const character of decoded) {
        const characterBytes = Buffer.byteLength(character, "utf8");
        if (bytesUsed + characterBytes > maxOutputBytes) {
          truncated = true;
          break;
        }
        stdout += character;
        bytesUsed += characterBytes;
      }
      resolve({ stdout, truncated });
    });
  });
}
