import { StudioDraftPersistenceError } from "../../application/drafts/persistence.js";

export function storageError(
  message: string,
  cause?: unknown
): StudioDraftPersistenceError {
  return new StudioDraftPersistenceError(
    "studio_storage_io_failed",
    message,
    { cause }
  );
}

export function invalidStorage(
  message: string,
  cause?: unknown
): StudioDraftPersistenceError {
  return new StudioDraftPersistenceError("studio_storage_invalid", message, {
    cause
  });
}

export function isErrno(cause: unknown, code: string): boolean {
  return (cause as NodeJS.ErrnoException).code === code;
}
