import { spawn } from "node:child_process";
import { repositoryIndexCapacityError } from "./repository-index-policy.js";

const GIT_BATCH_TIMEOUT_MS = 60_000;

export type GitBlobRequest = {
  readonly path: string;
  readonly oid: string;
};

async function gitBatch(input: {
  readonly root: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}): Promise<Buffer> {
  input.signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn("git", [...input.args], { cwd: input.root, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let stderrBytes = 0;
    let failure: unknown;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    const timeout = setTimeout(() => {
      failure = new Error(`Git batch timed out: git ${input.args.join(" ")}`);
      terminate();
    }, GIT_BATCH_TIMEOUT_MS);
    const abort = () => {
      failure = input.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
      terminate();
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted === true) {
      abort();
    }
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > input.maxOutputBytes) {
        failure = repositoryIndexCapacityError({
          phase: "read",
          resource: "git_output_bytes",
          observed: bytes,
          limit: input.maxOutputBytes
        });
        terminate();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = 64 * 1024 - stderrBytes;
      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining);
        stderr.push(captured);
        stderrBytes += captured.length;
      }
    });
    child.on("error", (cause) => {
      failure ??= cause;
    });
    child.stdin.on("error", (cause) => {
      failure ??= cause;
      terminate();
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      input.signal?.removeEventListener("abort", abort);
      if (failure !== undefined) {
        reject(failure);
      } else if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8") ||
          `git ${input.args.join(" ")} exited with ${code ?? "unknown"}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    child.stdin.end(input.stdin);
  });
}

export async function gitBlobSizes(
  root: string,
  requests: readonly GitBlobRequest[],
  maxOutputBytes: number,
  signal?: AbortSignal
): Promise<ReadonlyMap<string, number>> {
  if (requests.length === 0) {
    return new Map();
  }
  const output = await gitBatch({
    root,
    args: ["--no-replace-objects", "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    stdin: `${requests.map((request) => request.oid).join("\n")}\n`,
    maxOutputBytes,
    signal
  });
  const lines = output.toString("utf8").trimEnd().split("\n");
  if (lines.length !== requests.length) {
    throw new Error("Git blob metadata response count did not match the canonical index request.");
  }
  return new Map(lines.map((line, index) => {
    const [oid, kind, rawSize] = line.split(" ");
    const request = requests[index] as GitBlobRequest;
    const size = Number(rawSize);
    if (oid !== request.oid || kind !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Git object is not a valid blob for ${request.path}.`);
    }
    return [request.path, size];
  }));
}

export async function readGitBlobs(
  root: string,
  requests: readonly GitBlobRequest[],
  expectedBytes: number,
  signal?: AbortSignal
): Promise<ReadonlyMap<string, Buffer>> {
  if (requests.length === 0) {
    return new Map();
  }
  const headerAllowance = requests.length * 160 + 1;
  const output = await gitBatch({
    root,
    args: ["--no-replace-objects", "cat-file", "--batch"],
    stdin: `${requests.map((request) => request.oid).join("\n")}\n`,
    maxOutputBytes: expectedBytes + headerAllowance,
    signal
  });
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const request of requests) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1) {
      throw new Error(`Git blob header was truncated for ${request.path}.`);
    }
    const [oid, kind, rawSize] = output.subarray(offset, newline).toString("utf8").split(" ");
    const size = Number(rawSize);
    if (oid !== request.oid || kind !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Git object is not a valid blob for ${request.path}.`);
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= output.length || output[end] !== 0x0a) {
      throw new Error(`Git blob content was truncated for ${request.path}.`);
    }
    blobs.set(request.path, output.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== output.length) {
    throw new Error("Git blob batch returned unexpected trailing bytes.");
  }
  return blobs;
}

export async function readGitBlobPrefix(
  root: string,
  request: GitBlobRequest,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Buffer> {
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-replace-objects", "cat-file", "blob", request.oid], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const captured: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let stderrBytes = 0;
    let failure: unknown;
    const timeout = setTimeout(() => {
      failure = new Error(`Git blob prefix read timed out for ${request.path}.`);
      child.kill("SIGTERM");
    }, GIT_BATCH_TIMEOUT_MS);
    const abort = () => {
      failure = signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = maxBytes - capturedBytes;
      if (remaining > 0) {
        const prefix = chunk.subarray(0, remaining);
        captured.push(prefix);
        capturedBytes += prefix.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = 64 * 1024 - stderrBytes;
      if (remaining > 0) {
        const prefix = chunk.subarray(0, remaining);
        stderr.push(prefix);
        stderrBytes += prefix.length;
      }
    });
    child.on("error", (cause) => {
      failure ??= cause;
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (failure !== undefined) reject(failure);
      else if (code !== 0) reject(new Error(
        Buffer.concat(stderr).toString("utf8") ||
        `Git blob prefix read exited with ${code ?? "unknown"} for ${request.path}.`
      ));
      else resolve(Buffer.concat(captured));
    });
  });
}
