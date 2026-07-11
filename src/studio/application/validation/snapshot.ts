import type { StudioChangeSet } from "../../contracts/drafts.js";
import type { StudioPath } from "../../contracts/paths.js";

export type StudioValidationSnapshot = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly verifiedFiles: readonly StudioSnapshotVerifiedFile[];
  dispose(): Promise<void>;
};

export type StudioSnapshotVerifiedFile = {
  readonly file: StudioPath;
  readonly role: "base" | "dependency";
  readonly sha256: string | null;
};

export type StudioValidationSnapshotPort = {
  create(changeSet: StudioChangeSet): Promise<StudioValidationSnapshot>;
};

export type StudioSnapshotErrorCode =
  | "studio_snapshot_source_conflict"
  | "studio_snapshot_path_invalid"
  | "studio_snapshot_source_invalid"
  | "studio_snapshot_source_too_large"
  | "studio_snapshot_total_too_large"
  | "studio_snapshot_too_many_files"
  | "studio_snapshot_blob_invalid"
  | "studio_snapshot_io_failed"
  | "studio_snapshot_cleanup_failed";

export type StudioSnapshotErrorDetails = {
  readonly file?: StudioPath;
  readonly expectedSha256?: string | null;
  readonly actualSha256?: string | null;
  readonly actualBytes?: number;
  readonly maxBytes?: number;
  readonly actualFiles?: number;
  readonly maxFiles?: number;
  readonly work?: "source_read" | "blob_read" | "materialize";
};

export class StudioSnapshotError extends Error {
  readonly code: StudioSnapshotErrorCode;
  readonly details: StudioSnapshotErrorDetails;

  constructor(
    code: StudioSnapshotErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: StudioSnapshotErrorDetails;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "StudioSnapshotError";
    this.code = code;
    this.details = options.details ?? {};
  }
}

/**
 * Preserves both failures when an operation fails and its best-effort cleanup
 * also fails. Callers can handle the primary operation and cleanup causes
 * independently instead of losing the original failure to a `finally` throw.
 */
export class StudioSnapshotCleanupAggregateError extends AggregateError {
  readonly code = "studio_snapshot_cleanup_failed" as const;
  readonly operationCause: unknown;
  readonly cleanupCause: unknown;

  constructor(
    message: string,
    operationCause: unknown,
    cleanupCause: unknown
  ) {
    super([operationCause, cleanupCause], message, { cause: operationCause });
    this.name = "StudioSnapshotCleanupAggregateError";
    this.operationCause = operationCause;
    this.cleanupCause = cleanupCause;
  }
}
