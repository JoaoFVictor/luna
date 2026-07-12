import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  writeFileAtomically,
  type AtomicWriteFaultStage
} from "../../../core/filesystem/atomic-write.js";
import { StudioDraftPersistenceError } from "../../application/drafts/persistence.js";
import {
  assertStudioPrivateFileSize,
  type StudioPrivateFileLimit
} from "./storage-limits.js";
import {
  invalidStorage,
  isErrno,
  storageError
} from "./private-storage-errors.js";

const PRIVATE_FILE_MODE = 0o600;
const READ_CHUNK_BYTES = 64 * 1024;

export async function readPrivateFile(
  filePath: string,
  limit: StudioPrivateFileLimit
): Promise<Buffer | undefined> {
  let file;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) {
      return undefined;
    }
    if (isErrno(cause, "ELOOP")) {
      throw invalidStorage(`Refusing to read symbolic link: ${filePath}`, cause);
    }
    throw storageError(`Unable to open Studio storage file: ${filePath}`, cause);
  }

  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      throw invalidStorage(`Studio storage entry is not a file: ${filePath}`);
    }
    assertStudioPrivateFileSize(metadata.size, limit);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = limit.maxBytes + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        return Buffer.concat(chunks, totalBytes);
      }
      totalBytes += bytesRead;
      assertStudioPrivateFileSize(totalBytes, limit);
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } catch (cause) {
    if (cause instanceof StudioDraftPersistenceError) {
      throw cause;
    }
    throw storageError(`Unable to read Studio storage file: ${filePath}`, cause);
  } finally {
    await file.close();
  }
}

export async function writePrivateFile(
  filePath: string,
  content: string | Uint8Array,
  limit: StudioPrivateFileLimit,
  faultInjector?: (
    stage: AtomicWriteFaultStage
  ) => Promise<void> | void
): Promise<void> {
  const contentBytes =
    typeof content === "string"
      ? Buffer.byteLength(content, "utf8")
      : content.byteLength;
  assertStudioPrivateFileSize(contentBytes, limit);
  try {
    await writeFileAtomically(filePath, content, {
      mode: PRIVATE_FILE_MODE,
      errorCode: "studio_storage_io_failed",
      commitAmbiguousErrorCode: "studio_storage_commit_ambiguous",
      errorLabel: "Studio private file write",
      faultInjector
    });
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "commitState" in cause &&
      cause.commitState === "commit_ambiguous"
    ) {
      throw new StudioDraftPersistenceError(
        "studio_storage_commit_ambiguous",
        "Studio private file write may have committed",
        { cause }
      );
    }
    throw storageError(`Unable to write Studio storage file: ${filePath}`, cause);
  }
}
