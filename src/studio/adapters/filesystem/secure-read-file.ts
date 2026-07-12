import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  open,
  realpath,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import {
  assertSafeSegment,
  isInsideRoot
} from "../../../core/security/path.js";

export type SecureReadFileErrorCode =
  | "missing"
  | "not_regular_file"
  | "security_violation"
  | "size_unsupported"
  | "io_failed";

export class SecureReadFileError extends Error {
  readonly code: SecureReadFileErrorCode;

  constructor(code: SecureReadFileErrorCode, message: string) {
    super(message);
    this.name = "SecureReadFileError";
    this.code = code;
  }
}

export type SecureReadonlyFile = {
  readonly handle: FileHandle;
  readonly size: number;
  readonly device: string;
  readonly inode: string;
  readonly modified_nanoseconds: string;
  readonly changed_nanoseconds: string;
};

function secureError(
  code: SecureReadFileErrorCode,
  message: string
): SecureReadFileError {
  return new SecureReadFileError(code, message);
}

function errnoCode(cause: unknown): string | undefined {
  return cause !== null && typeof cause === "object" && "code" in cause
    ? String((cause as { code?: unknown }).code)
    : undefined;
}

function mapFilesystemError(cause: unknown): SecureReadFileError {
  if (cause instanceof SecureReadFileError) {
    return cause;
  }
  const code = errnoCode(cause);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return secureError("missing", "Requested file is unavailable");
  }
  if (code === "ELOOP") {
    return secureError("security_violation", "Symbolic links are not allowed");
  }
  if (
    cause !== null &&
    typeof cause === "object" &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "path_security_violation"
  ) {
    return secureError("security_violation", "Requested path is not allowed");
  }
  return secureError("io_failed", "Requested file could not be read");
}

function safeNumericSize(size: bigint): number {
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw secureError("size_unsupported", "Requested file size is unsupported");
  }
  return Number(size);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openedFileRealpath(
  handle: FileHandle,
  candidate: string
): Promise<string> {
  try {
    return await realpath(`/proc/self/fd/${handle.fd}`);
  } catch (cause) {
    const code = errnoCode(cause);
    if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EINVAL") {
      throw cause;
    }
    return await realpath(candidate);
  }
}

/**
 * Opens one regular file below a configured root without following symlinks.
 * The returned handle pins the opened inode. No logical or physical pathname
 * crosses the application boundary.
 */
export async function openSecureRegularFile(
  root: string,
  segments: readonly string[]
): Promise<SecureReadonlyFile> {
  let handle: FileHandle | undefined;
  try {
    for (const segment of segments) {
      assertSafeSegment(segment);
    }

    const rootReal = await realpath(root);
    const rootStat = await lstat(rootReal, { bigint: true });
    if (!rootStat.isDirectory()) {
      throw secureError("security_violation", "Configured root is not a directory");
    }

    let candidate = rootReal;
    let finalPathStat: BigIntStats | undefined;
    for (const [index, segment] of segments.entries()) {
      candidate = path.join(candidate, segment);
      const current = await lstat(candidate, { bigint: true });
      if (current.isSymbolicLink()) {
        throw secureError("security_violation", "Symbolic links are not allowed");
      }
      const final = index === segments.length - 1;
      if (!final && !current.isDirectory()) {
        throw secureError("security_violation", "Path ancestor is not a directory");
      }
      if (final) {
        finalPathStat = current;
      }
    }

    if (finalPathStat === undefined || !finalPathStat.isFile()) {
      throw secureError("not_regular_file", "Requested content is not a regular file");
    }
    if (!isInsideRoot(rootReal, candidate)) {
      throw secureError("security_violation", "Requested path is outside the root");
    }

    handle = await open(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const openedStat = await handle.stat({ bigint: true });
    if (!openedStat.isFile() || !sameIdentity(finalPathStat, openedStat)) {
      throw secureError("security_violation", "Requested file changed while opening");
    }

    const openedReal = await openedFileRealpath(handle, candidate);
    if (!isInsideRoot(rootReal, openedReal)) {
      throw secureError("security_violation", "Opened file is outside the root");
    }

    const result: SecureReadonlyFile = {
      handle,
      size: safeNumericSize(openedStat.size),
      device: openedStat.dev.toString(10),
      inode: openedStat.ino.toString(10),
      modified_nanoseconds: openedStat.mtimeNs.toString(10),
      changed_nanoseconds: openedStat.ctimeNs.toString(10)
    };
    handle = undefined;
    return result;
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    throw mapFilesystemError(cause);
  }
}
