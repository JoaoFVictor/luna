import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import path from "node:path";
import type { RepositoryConfig } from "../../../core/config/schemas.js";
import { runStudioGitRead, StudioGitProcessError } from "../git/read-process.js";
import { studioRunValueDigest } from "../../application/runs/launch-digests.js";
import { studioRunLaunchError } from "../../application/runs/launch-errors.js";

const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 5_000;
const MAX_UNTRACKED_BYTES = 64 * 1024 * 1024;
const FINGERPRINT_TIMEOUT_MS = 5_000;
const FILE_READ_CHUNK_BYTES = 64 * 1024;

type GitObjectFormat = "sha1" | "sha256";

export type NativeStudioRepositoryFingerprintOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxUntrackedBytes?: number;
};

function boundedPositiveInteger(
  value: number,
  maximum: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} is outside its supported range`);
  }
  return value;
}

function assertWithinDeadline(deadline: number, signal: AbortSignal): void {
  if (signal.aborted) {
    throw new StudioGitProcessError("aborted");
  }
  if (Date.now() >= deadline) {
    throw new StudioGitProcessError("timed_out");
  }
}

function remainingTimeout(deadline: number, signal: AbortSignal): number {
  assertWithinDeadline(deadline, signal);
  return Math.max(1, deadline - Date.now());
}

function parseObjectFormat(stdout: Buffer): GitObjectFormat {
  const value = stdout.toString("utf8").trim();
  if (value !== "sha1" && value !== "sha256") {
    throw new Error("repository uses an unsupported Git object format");
  }
  return value;
}

function parseListedPaths(stdout: Buffer): readonly string[] {
  const result: string[] = [];
  let start = 0;
  for (let index = 0; index < stdout.length; index += 1) {
    if (stdout[index] !== 0) {
      continue;
    }
    const encoded = stdout.subarray(start, index);
    start = index + 1;
    if (encoded.length === 0) {
      continue;
    }
    const value = encoded.toString("utf8");
    if (!Buffer.from(value, "utf8").equals(encoded)) {
      throw new Error("repository contains a non-UTF-8 untracked path");
    }
    result.push(value);
  }
  if (start !== stdout.length) {
    throw new Error("Git returned an unterminated untracked path list");
  }
  if (result.length > MAX_UNTRACKED_FILES) {
    throw new Error("repository contains too many untracked files");
  }
  return result;
}

function absoluteListedPath(repositoryPath: string, listedPath: string): string {
  if (path.isAbsolute(listedPath) || listedPath === "") {
    throw new Error("Git returned an invalid untracked path");
  }
  const absolute = path.resolve(repositoryPath, listedPath);
  const relative = path.relative(path.resolve(repositoryPath), absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Git returned an untracked path outside the repository");
  }
  return absolute;
}

function sameFileVersion(
  left: BigIntStats,
  right: BigIntStats
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function reserveBytes(
  size: bigint,
  budget: { remaining: number }
): number {
  if (size < 0n || size > BigInt(budget.remaining)) {
    throw new Error("repository untracked content exceeds its byte budget");
  }
  const value = Number(size);
  if (!Number.isSafeInteger(value)) {
    throw new Error("repository contains an unsupported untracked file size");
  }
  budget.remaining -= value;
  return value;
}

function gitBlobHasher(format: GitObjectFormat, size: number) {
  const digest = createHash(format);
  digest.update(Buffer.from(`blob ${size}\0`, "utf8"));
  return digest;
}

async function hashRegularFile(input: {
  readonly absolutePath: string;
  readonly initial: BigIntStats;
  readonly format: GitObjectFormat;
  readonly budget: { remaining: number };
  readonly deadline: number;
  readonly signal: AbortSignal;
}): Promise<string> {
  const size = reserveBytes(input.initial.size, input.budget);
  const handle = await open(
    input.absolutePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileVersion(input.initial, opened)) {
      throw new Error("untracked file changed before it could be fingerprinted");
    }
    const digest = gitBlobHasher(input.format, size);
    const buffer = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_BYTES, size));
    let position = 0;
    while (position < size) {
      assertWithinDeadline(input.deadline, input.signal);
      const length = Math.min(buffer.length, size - position);
      const read = await handle.read(buffer, 0, length, position);
      if (read.bytesRead !== length) {
        throw new Error("untracked file changed while it was fingerprinted");
      }
      digest.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const completed = await handle.stat({ bigint: true });
    if (!sameFileVersion(opened, completed)) {
      throw new Error("untracked file changed while it was fingerprinted");
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

async function hashSymbolicLink(input: {
  readonly absolutePath: string;
  readonly initial: BigIntStats;
  readonly format: GitObjectFormat;
  readonly budget: { remaining: number };
  readonly deadline: number;
  readonly signal: AbortSignal;
}): Promise<string> {
  assertWithinDeadline(input.deadline, input.signal);
  const target = await readlink(input.absolutePath, { encoding: "buffer" });
  const size = reserveBytes(BigInt(target.byteLength), input.budget);
  const completed = await lstat(input.absolutePath, { bigint: true });
  if (
    !completed.isSymbolicLink() ||
    input.initial.size !== BigInt(target.byteLength) ||
    !sameFileVersion(input.initial, completed)
  ) {
    throw new Error("untracked symbolic link changed while it was fingerprinted");
  }
  const digest = gitBlobHasher(input.format, size);
  digest.update(target);
  return digest.digest("hex");
}

async function untrackedBlobIds(input: {
  readonly repositoryPath: string;
  readonly listed: Buffer;
  readonly format: GitObjectFormat;
  readonly maxBytes: number;
  readonly deadline: number;
  readonly signal: AbortSignal;
}): Promise<readonly { readonly path: string; readonly blob: string }[]> {
  const paths = parseListedPaths(input.listed);
  const budget = { remaining: input.maxBytes };
  const result: { path: string; blob: string }[] = [];
  for (const listedPath of paths) {
    assertWithinDeadline(input.deadline, input.signal);
    const absolutePath = absoluteListedPath(input.repositoryPath, listedPath);
    const initial = await lstat(absolutePath, { bigint: true });
    const blob = initial.isFile()
      ? await hashRegularFile({
          absolutePath,
          initial,
          format: input.format,
          budget,
          deadline: input.deadline,
          signal: input.signal
        })
      : initial.isSymbolicLink()
        ? await hashSymbolicLink({
            absolutePath,
            initial,
            format: input.format,
            budget,
            deadline: input.deadline,
            signal: input.signal
          })
        : undefined;
    if (blob === undefined) {
      throw new Error("repository contains an unsupported untracked file type");
    }
    result.push({ path: listedPath, blob });
  }
  return result;
}

export async function fingerprintNativeStudioRepository(
  repository: RepositoryConfig,
  options: NativeStudioRepositoryFingerprintOptions = {}
): Promise<string> {
  const controller = new AbortController();
  const signal = options.signal === undefined
    ? controller.signal
    : AbortSignal.any([options.signal, controller.signal]);
  try {
    const timeoutMs = boundedPositiveInteger(
      options.timeoutMs ?? FINGERPRINT_TIMEOUT_MS,
      FINGERPRINT_TIMEOUT_MS,
      "Repository fingerprint timeout"
    );
    const maxUntrackedBytes = boundedPositiveInteger(
      options.maxUntrackedBytes ?? MAX_UNTRACKED_BYTES,
      MAX_UNTRACKED_BYTES,
      "Repository untracked byte budget"
    );
    const deadline = Date.now() + timeoutMs;
    const git = async (args: readonly string[]): Promise<Buffer> =>
      (await runStudioGitRead({
        cwd: repository.path,
        args,
        signal,
        timeoutMs: remainingTimeout(deadline, signal),
        maxStdoutBytes: MAX_GIT_OUTPUT_BYTES
      })).stdout;
    const [head, diff, listed, objectFormat] = await Promise.all([
      git(["rev-parse", "--verify", "HEAD"]),
      git([
        "diff",
        "--binary",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "HEAD",
        "--"
      ]),
      git(["ls-files", "--others", "--exclude-standard", "-z"]),
      git(["rev-parse", "--show-object-format"])
    ]);
    const untracked = await untrackedBlobIds({
      repositoryPath: repository.path,
      listed,
      format: parseObjectFormat(objectFormat),
      maxBytes: maxUntrackedBytes,
      deadline,
      signal
    });
    return studioRunValueDigest({
      repository,
      head: head.toString("utf8").trim(),
      tracked_changes: studioRunValueDigest(diff.toString("base64")),
      untracked
    });
  } catch (cause) {
    controller.abort();
    throw studioRunLaunchError(
      "studio_run_plan_resolution_invalid",
      "Configured repository could not be fingerprinted safely",
      { repository_id: repository.id },
      { cause }
    );
  } finally {
    controller.abort();
  }
}
