import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  repositoryIndexCapacityError,
  REPOSITORY_INDEX_RESOURCE_POLICY
} from "./repository-index-policy.js";

const STDERR_CAPTURE_BYTES = 64 * 1024;
const GIT_STREAM_TIMEOUT_MS = 60_000;

async function streamGit(input: {
  readonly root: string;
  readonly args: readonly string[];
  readonly maxBytes: number;
  readonly phase: "inventory" | "preflight";
  readonly onChunk: (chunk: Buffer) => void;
  readonly signal?: AbortSignal;
}): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", [...input.args], {
      cwd: input.root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let bytes = 0;
    let failure: unknown;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    const timeout = setTimeout(() => {
      failure = new Error(`Git command timed out: git ${input.args.join(" ")}`);
      child.kill("SIGTERM");
    }, GIT_STREAM_TIMEOUT_MS);
    const abort = () => {
      failure = input.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
      child.kill("SIGTERM");
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted === true) {
      abort();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (failure !== undefined) {
        return;
      }
      bytes += chunk.length;
      if (bytes > input.maxBytes) {
        failure = repositoryIndexCapacityError({
          phase: input.phase,
          resource: "git_output_bytes",
          observed: bytes,
          limit: input.maxBytes
        });
        child.kill("SIGTERM");
        return;
      }
      try {
        input.onChunk(chunk);
      } catch (cause) {
        failure = cause;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = STDERR_CAPTURE_BYTES - stderrBytes;
      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining);
        stderr.push(captured);
        stderrBytes += captured.length;
      }
    });
    child.on("error", (cause) => {
      failure = cause;
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      if (failure !== undefined) {
        reject(failure);
      } else if (code !== 0) {
        reject(new Error(
          Buffer.concat(stderr).toString("utf8").trim() ||
          `Git command failed: git ${input.args.join(" ")} (exit ${code ?? "unknown"})`
        ));
      } else {
        resolve(bytes);
      }
    });
  });
}

export async function gitNulFields(input: {
  readonly root: string;
  readonly args: readonly string[];
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly phase: "inventory" | "preflight";
  readonly signal?: AbortSignal;
}): Promise<{ readonly fields: readonly string[]; readonly bytes: number }> {
  const decoder = new StringDecoder("utf8");
  const fields: string[] = [];
  let pending = "";
  function append(value: string): void {
    if (value === "") {
      return;
    }
    fields.push(value);
    if (fields.length > input.maxEntries) {
      throw repositoryIndexCapacityError({
        phase: input.phase,
        resource: "entries",
        observed: fields.length,
        limit: input.maxEntries
      });
    }
  }

  const bytes = await streamGit({
    ...input,
    onChunk(chunk) {
      pending += decoder.write(chunk);
      let separator = pending.indexOf("\0");
      while (separator >= 0) {
        append(pending.slice(0, separator));
        pending = pending.slice(separator + 1);
        separator = pending.indexOf("\0");
      }
    }
  });
  pending += decoder.end();
  append(pending);
  return { fields, bytes };
}

export async function gitOutputDigest(
  root: string,
  args: readonly string[],
  signal?: AbortSignal
): Promise<{ readonly digest: string; readonly nonempty: boolean }> {
  const hash = createHash("sha256");
  let nonempty = false;
  await streamGit({
    root,
    args,
    maxBytes: REPOSITORY_INDEX_RESOURCE_POLICY.max_git_metadata_bytes,
    phase: "preflight",
    signal,
    onChunk(chunk) {
      nonempty ||= chunk.length > 0;
      hash.update(chunk);
    }
  });
  return { digest: hash.digest("hex"), nonempty };
}
