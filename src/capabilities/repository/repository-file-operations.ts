import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import { isInsideRoot } from "../../core/security/path.js";

function repositoryFileError(
  message: string,
  code:
    | "repository_tool_path_escape"
    | "repository_tool_not_directory"
    | "repository_tool_security_violation"
): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function normalizedFilePath(requestedPath: string): readonly string[] {
  if (
    path.isAbsolute(requestedPath) ||
    requestedPath.includes("\\") ||
    requestedPath.includes("\0")
  ) {
    throw repositoryFileError(
      "Repository file paths must be relative to the bound worktree.",
      "repository_tool_path_escape"
    );
  }

  const segments: string[] = [];
  for (const segment of requestedPath.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw repositoryFileError(
        "Repository file path escaped the bound worktree.",
        "repository_tool_path_escape"
      );
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    throw repositoryFileError(
      "Repository file operations require a file path.",
      "repository_tool_security_violation"
    );
  }
  return segments;
}

function fdPath(handle: FileHandle, entry?: string): string {
  const root = `/proc/self/fd/${handle.fd}`;
  return entry === undefined ? root : path.join(root, entry);
}

const NOFOLLOW_FLAG =
  typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

export type SecureRepositoryWriteFaultStage =
  | "after_temp_opened"
  | "after_file_synced"
  | "after_rename";

async function assertOpenedInsideRoot(
  handle: FileHandle,
  rootReal: string
): Promise<void> {
  const openedReal = await realpath(fdPath(handle));
  if (!isInsideRoot(rootReal, openedReal)) {
    throw repositoryFileError(
      "Repository file operation opened a path outside the bound worktree.",
      "repository_tool_security_violation"
    );
  }
}

async function openDirectory(
  candidate: string,
  rootReal: string
): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      candidate,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const stats = await handle.stat();
    if (!stats.isDirectory()) {
      throw repositoryFileError(
        "Repository file path parent is not a directory.",
        "repository_tool_not_directory"
      );
    }
    await assertOpenedInsideRoot(handle, rootReal);
    const result = handle;
    handle = undefined;
    return result;
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw repositoryFileError(
        "Repository file operations do not follow symbolic-link directories.",
        "repository_tool_not_directory"
      );
    }
    throw cause;
  }
}

async function openRepositoryParent(input: {
  readonly cwd: string;
  readonly requestedPath: string;
  readonly createDirectories: boolean;
}): Promise<{
  readonly rootReal: string;
  readonly entryName: string;
  readonly directory: FileHandle;
}> {
  const segments = normalizedFilePath(input.requestedPath);
  const entryName = segments.at(-1)!;
  const rootReal = await realpath(input.cwd);
  const rootStats = await lstat(rootReal);
  if (!rootStats.isDirectory()) {
    throw repositoryFileError(
      "The bound repository worktree is not a directory.",
      "repository_tool_not_directory"
    );
  }

  let directory = await openDirectory(rootReal, rootReal);
  try {
    for (const segment of segments.slice(0, -1)) {
      let child: FileHandle;
      try {
        child = await openDirectory(fdPath(directory, segment), rootReal);
      } catch (cause) {
        if (
          !input.createDirectories ||
          (cause as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          throw cause;
        }

        await mkdir(fdPath(directory, segment)).catch((mkdirCause: unknown) => {
          if ((mkdirCause as NodeJS.ErrnoException).code !== "EEXIST") {
            throw mkdirCause;
          }
        });
        child = await openDirectory(fdPath(directory, segment), rootReal);
      }
      const previous = directory;
      directory = child;
      await previous.close();
    }

    return { rootReal, entryName, directory };
  } catch (cause) {
    await directory.close().catch(() => undefined);
    throw cause;
  }
}

export async function readSecureRepositoryFile(input: {
  readonly cwd: string;
  readonly requestedPath: string;
  readonly maxBytes: number;
}): Promise<{ readonly content: Buffer; readonly size: number }> {
  const parent = await openRepositoryParent({
    ...input,
    createDirectories: false
  });
  let file: FileHandle | undefined;
  try {
    file = await open(
      fdPath(parent.directory, parent.entryName),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw repositoryFileError(
        "Repository reads require a regular non-symlink file.",
        "repository_tool_security_violation"
      );
    }
    await assertOpenedInsideRoot(file, parent.rootReal);
    const length = Math.min(stats.size, input.maxBytes);
    const buffer = Buffer.alloc(length);
    const read = await file.read(buffer, 0, length, 0);
    return {
      content: buffer.subarray(0, read.bytesRead),
      size: stats.size
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ELOOP") {
      throw repositoryFileError(
        "Repository reads do not follow symbolic links.",
        "repository_tool_security_violation"
      );
    }
    throw cause;
  } finally {
    await file?.close().catch(() => undefined);
    await parent.directory.close().catch(() => undefined);
  }
}

export async function writeSecureRepositoryFile(input: {
  readonly cwd: string;
  readonly requestedPath: string;
  readonly content: string;
  readonly createDirectories: boolean;
  /** Explicit failure seam for atomicity tests; production callers omit it. */
  readonly faultInjector?: (
    stage: SecureRepositoryWriteFaultStage
  ) => Promise<void> | void;
}): Promise<void> {
  const parent = await openRepositoryParent(input);
  let existingFile: FileHandle | undefined;
  let temporaryFile: FileHandle | undefined;
  let temporaryEntry: string | undefined;
  let renamed = false;
  try {
    let mode: number;
    try {
      existingFile = await open(
        fdPath(parent.directory, parent.entryName),
        constants.O_RDONLY | NOFOLLOW_FLAG | constants.O_NONBLOCK
      );
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ELOOP") {
        throw repositoryFileError(
          "Repository writes do not follow symbolic links.",
          "repository_tool_security_violation"
        );
      }
      if (code !== "ENOENT") {
        throw cause;
      }
    }

    if (existingFile === undefined) {
      mode = 0o666 & ~process.umask();
    } else {
      const [openedStats, entryStats] = await Promise.all([
        existingFile.stat(),
        lstat(fdPath(parent.directory, parent.entryName))
      ]);
      if (
        entryStats.isSymbolicLink() ||
        !openedStats.isFile() ||
        openedStats.dev !== entryStats.dev ||
        openedStats.ino !== entryStats.ino
      ) {
        throw repositoryFileError(
          "Repository writes require a regular non-symlink file.",
          "repository_tool_security_violation"
        );
      }
      await assertOpenedInsideRoot(existingFile, parent.rootReal);
      mode = openedStats.mode & 0o777;
      await existingFile.close();
      existingFile = undefined;
    }

    temporaryEntry = `.luna-write-${process.pid}-${randomBytes(12).toString("hex")}.tmp`;
    temporaryFile = await open(
      fdPath(parent.directory, temporaryEntry),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        NOFOLLOW_FLAG |
        constants.O_NONBLOCK,
      mode
    );
    const temporaryStats = await temporaryFile.stat();
    if (!temporaryStats.isFile()) {
      throw repositoryFileError(
        "Repository writes require a regular temporary file.",
        "repository_tool_security_violation"
      );
    }
    await assertOpenedInsideRoot(temporaryFile, parent.rootReal);
    await input.faultInjector?.("after_temp_opened");
    await temporaryFile.writeFile(input.content, "utf8");
    await temporaryFile.chmod(mode);
    await temporaryFile.sync();
    await input.faultInjector?.("after_file_synced");
    await temporaryFile.close();
    temporaryFile = undefined;

    await rename(
      fdPath(parent.directory, temporaryEntry),
      fdPath(parent.directory, parent.entryName)
    );
    renamed = true;
    await input.faultInjector?.("after_rename");
    await parent.directory.sync();
  } catch (cause) {
    await existingFile?.close().catch(() => undefined);
    existingFile = undefined;
    await temporaryFile?.close().catch(() => undefined);
    temporaryFile = undefined;
    if (!renamed && temporaryEntry !== undefined) {
      await unlink(fdPath(parent.directory, temporaryEntry)).catch(
        (cleanupCause: unknown) => {
          if ((cleanupCause as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new AggregateError(
              [cause, cleanupCause],
              "Repository atomic write and temporary-file cleanup both failed."
            );
          }
        }
      );
    }
    throw cause;
  } finally {
    await existingFile?.close().catch(() => undefined);
    await temporaryFile?.close().catch(() => undefined);
    await parent.directory.close().catch(() => undefined);
  }
}

export async function deleteSecureRepositoryFile(input: {
  readonly cwd: string;
  readonly requestedPath: string;
}): Promise<void> {
  const parent = await openRepositoryParent({
    ...input,
    createDirectories: false
  });
  try {
    await unlink(fdPath(parent.directory, parent.entryName));
  } finally {
    await parent.directory.close().catch(() => undefined);
  }
}
