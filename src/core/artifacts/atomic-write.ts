import { chmod, open, rename, rm } from "node:fs/promises";
import path from "node:path";

export interface AtomicWriteHooks {
  onTempFileCreated?: (tempPath: string) => void;
  onFileSynced?: () => void;
  onDirectorySynced?: () => void;
}

export type AtomicWriteContent = string | Uint8Array;

function atomicWriteError(
  cause: unknown,
  cleanupCause?: unknown
): Error & { code: string } {
  const message =
    cause instanceof Error
      ? `Atomic artifact write failed: ${cause.message}`
      : "Atomic artifact write failed";
  const errorCause =
    cleanupCause === undefined ? cause : { write: cause, cleanup: cleanupCause };
  const error = new Error(message, { cause: errorCause }) as Error & {
    code: string;
  };
  error.code = "artifact_atomic_write_failed";

  return error;
}

function tempPathFor(targetPath: string): string {
  const directory = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  const unique = `${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}`;

  return path.join(directory, `.${basename}.${unique}.tmp`);
}

export async function atomicWriteFile(
  targetPath: string,
  content: AtomicWriteContent,
  mode: number,
  hooks: AtomicWriteHooks = {}
): Promise<void> {
  const tempPath = tempPathFor(targetPath);
  let tempCreated = false;

  try {
    const file = await open(tempPath, "wx", mode);
    tempCreated = true;
    hooks.onTempFileCreated?.(tempPath);

    try {
      await file.writeFile(content);
      await file.sync();
      hooks.onFileSynced?.();
    } finally {
      await file.close();
    }

    await rename(tempPath, targetPath);
    tempCreated = false;
    await chmod(targetPath, mode);

    const directory = await open(path.dirname(targetPath), "r");
    try {
      await directory.sync();
      hooks.onDirectorySynced?.();
    } finally {
      await directory.close();
    }
  } catch (cause) {
    let cleanupCause: unknown;

    if (tempCreated) {
      try {
        await rm(tempPath, { force: true });
      } catch (error) {
        cleanupCause = error;
      }
    }

    throw atomicWriteError(cause, cleanupCause);
  }
}
