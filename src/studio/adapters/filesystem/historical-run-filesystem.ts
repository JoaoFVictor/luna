import { constants, type BigIntStats, type Dir } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";

const READ_DIRECTORY_FLAGS =
  constants.O_RDONLY |
  constants.O_DIRECTORY |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;
const READ_FILE_FLAGS =
  constants.O_RDONLY |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

type PinnedDirectory = {
  readonly handle: FileHandle;
  readonly descriptorPath: string;
  readonly stats: BigIntStats;
};

export type PinnedHistoricalRunRoot = PinnedDirectory;
export type PinnedHistoricalRunDirectory = PinnedDirectory;

export type PinnedHistoricalRunFile = {
  readonly handle: FileHandle;
  readonly size: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly changedNanoseconds: bigint;
};

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeSize(size: bigint): number | undefined {
  return size >= 0n && size <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(size)
    : undefined;
}

function isSafeName(name: string): boolean {
  return name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    path.basename(name) === name &&
    !name.includes("/") &&
    !name.includes("\\");
}

async function descriptorPathFor(
  handle: FileHandle,
  identity: BigIntStats
): Promise<string | undefined> {
  for (const base of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = path.join(base, String(handle.fd));
    try {
      const resolved = await realpath(candidate);
      const resolvedStats = await lstat(resolved, { bigint: true });
      if (sameIdentity(identity, resolvedStats)) {
        return candidate;
      }
    } catch {
      // Try the next descriptor filesystem. Unsafe path fallback is forbidden.
    }
  }
  return undefined;
}

async function pinDirectory(
  directoryPath: string
): Promise<PinnedDirectory | undefined> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(directoryPath, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      return undefined;
    }
    handle = await open(directoryPath, READ_DIRECTORY_FLAGS);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameIdentity(before, opened)) {
      return undefined;
    }
    const descriptorPath = await descriptorPathFor(handle, opened);
    if (descriptorPath === undefined) {
      return undefined;
    }
    const pinned = { handle, descriptorPath, stats: opened };
    handle = undefined;
    return pinned;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function pinHistoricalRunRoot(
  rootPath: string
): Promise<PinnedHistoricalRunRoot | undefined> {
  return await pinDirectory(rootPath);
}

export async function configuredRootMatches(
  rootPath: string,
  pinned: PinnedHistoricalRunRoot
): Promise<boolean> {
  try {
    const current = await lstat(rootPath, { bigint: true });
    return current.isDirectory() &&
      !current.isSymbolicLink() &&
      sameIdentity(current, pinned.stats);
  } catch {
    return false;
  }
}

export async function openPinnedRootDirectory(
  root: PinnedHistoricalRunRoot
): Promise<Dir | undefined> {
  try {
    return await opendir(root.descriptorPath);
  } catch {
    return undefined;
  }
}

export async function openPinnedRunDirectory(
  root: PinnedHistoricalRunRoot,
  runId: string
): Promise<PinnedHistoricalRunDirectory | undefined> {
  if (!isSafeName(runId)) {
    return undefined;
  }
  return await pinDirectory(path.join(root.descriptorPath, runId));
}

export async function openPinnedRunFile(
  directory: PinnedHistoricalRunDirectory,
  fileName: string
): Promise<PinnedHistoricalRunFile | undefined> {
  if (!isSafeName(fileName)) {
    return undefined;
  }
  let handle: FileHandle | undefined;
  try {
    const filePath = path.join(directory.descriptorPath, fileName);
    const before = await lstat(filePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      return undefined;
    }
    handle = await open(filePath, READ_FILE_FLAGS);
    const opened = await handle.stat({ bigint: true });
    const size = safeSize(opened.size);
    if (
      size === undefined ||
      !opened.isFile() ||
      !sameIdentity(before, opened)
    ) {
      return undefined;
    }
    const pinned = {
      handle,
      size,
      device: opened.dev,
      inode: opened.ino,
      modifiedNanoseconds: opened.mtimeNs,
      changedNanoseconds: opened.ctimeNs
    };
    handle = undefined;
    return pinned;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function pinnedHistoricalRunFileUnchanged(
  file: PinnedHistoricalRunFile
): Promise<boolean> {
  try {
    const current = await file.handle.stat({ bigint: true });
    return current.isFile() &&
      current.dev === file.device &&
      current.ino === file.inode &&
      current.size === BigInt(file.size) &&
      current.mtimeNs === file.modifiedNanoseconds &&
      current.ctimeNs === file.changedNanoseconds;
  } catch {
    return false;
  }
}

export async function closePinnedDirectory(
  directory: PinnedDirectory | undefined
): Promise<void> {
  await directory?.handle.close().catch(() => undefined);
}

export function pinnedDirectoryTimestamp(
  directory: PinnedHistoricalRunDirectory
): string {
  const candidate = directory.stats.birthtimeMs > 0n
    ? directory.stats.birthtime
    : directory.stats.mtime;
  return candidate.toISOString();
}
