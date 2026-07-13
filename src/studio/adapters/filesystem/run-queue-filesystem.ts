import { constants } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import path from "node:path";
import {
  StudioRunLaunchError,
  studioRunLaunchError
} from "../../application/runs/launch-errors.js";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const MAX_JOB_FILE_BYTES = 4 * 1024 * 1024;

export function queueError(message: string, cause?: unknown): Error {
  return studioRunLaunchError(
    "studio_run_dispatch_failed",
    message,
    {},
    cause === undefined ? undefined : { cause }
  );
}

export function queueCorruptionError(message: string, cause?: unknown): Error {
  return studioRunLaunchError(
    "studio_run_dispatch_failed",
    message,
    { queue_corruption: true },
    cause === undefined ? undefined : { cause }
  );
}

export function isNativeStudioRunDispatchQueueCorruption(
  cause: unknown
): boolean {
  return cause instanceof StudioRunLaunchError &&
    cause.details.queue_corruption === true;
}

export function isErrno(cause: unknown, ...codes: readonly string[]): boolean {
  return codes.includes((cause as NodeJS.ErrnoException).code ?? "");
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw queueError("Native run dispatch storage must use physical directories");
  }
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await handle.chmod(PRIVATE_DIRECTORY_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectoryTree(directory: string): Promise<void> {
  const entries = await opendir(directory);
  try {
    for await (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw queueError("Native run dispatch storage contains a symbolic link");
      }
      if (entry.isDirectory()) {
        await syncDirectoryTree(path.join(directory, entry.name));
      }
    }
  } finally {
    await entries.close().catch(() => undefined);
  }
  await syncDirectory(directory);
}

export async function writeDurableFile(
  filePath: string,
  content: string
): Promise<void> {
  const handle = await open(
    filePath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
