import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY |
  constants.O_NOFOLLOW | constants.O_NONBLOCK;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function unavailable(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR", "ELOOP"].includes(
    (error as NodeJS.ErrnoException).code ?? ""
  );
}

function safeSegments(relativePath: string): string[] | undefined {
  const normalized = relativePath.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized)) {
    return undefined;
  }
  const segments = normalized.split("/");
  return segments.length === 0 || segments.some((segment) =>
    segment === "" || segment === "." || segment === ".."
  ) ? undefined : segments;
}

async function openOrUnavailable(filePath: string, flags: number): Promise<FileHandle | undefined> {
  return await open(filePath, flags).catch((cause: unknown) => {
    if (unavailable(cause)) {
      return undefined;
    }
    throw cause;
  });
}

// Linux /proc/self/fd paths provide fd-relative traversal without falling back
// to a realpath-then-open TOCTOU window. Every parent is a pinned, non-symlink
// directory fd; renames cannot redirect a traversal already in progress.
export async function openFileBeneath(
  root: string,
  relativePath: string
): Promise<FileHandle | undefined> {
  if (constants.O_NOFOLLOW === 0 || constants.O_DIRECTORY === 0) {
    throw new Error("Secure root traversal requires O_NOFOLLOW and O_DIRECTORY support.");
  }
  const segments = safeSegments(relativePath);
  if (segments === undefined) {
    return undefined;
  }
  let directory = await openOrUnavailable(root, DIRECTORY_FLAGS);
  if (directory === undefined) {
    return undefined;
  }
  try {
    for (const segment of segments.slice(0, -1)) {
      const next = await openOrUnavailable(
        `/proc/self/fd/${directory.fd}/${segment}`,
        DIRECTORY_FLAGS
      );
      if (next === undefined) {
        return undefined;
      }
      await directory.close();
      directory = next;
    }
    return await openOrUnavailable(
      `/proc/self/fd/${directory.fd}/${segments.at(-1) as string}`,
      FILE_FLAGS
    );
  } finally {
    await directory.close().catch(() => undefined);
  }
}
