import { StudioDraftPersistenceError } from "../../application/drafts/persistence.js";

const MAX_CONFIGURED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_CONFIGURED_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_CONFIGURED_ENTRIES = 1_000_000;
const MAX_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type StudioDraftStorageLimits = {
  readonly maxBlobBytes: number;
  readonly maxChangeSetBytes: number;
  readonly maxTotalBytes: number;
  readonly maxEntries: number;
  readonly deleteTombstoneRetentionMs: number;
};

export const DEFAULT_STUDIO_DRAFT_STORAGE_LIMITS: StudioDraftStorageLimits = {
  maxBlobBytes: 2 * 1024 * 1024,
  maxChangeSetBytes: 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: 10_000,
  deleteTombstoneRetentionMs: 5 * 60 * 1_000
};

export type StudioPrivateFileLimit = {
  readonly maxBytes: number;
  readonly tooLargeCode: "studio_blob_too_large" | "studio_draft_too_large";
  readonly label: string;
};

export type ResolvedStudioDraftStorageLimits = {
  readonly blob: StudioPrivateFileLimit;
  readonly changeSet: StudioPrivateFileLimit;
  readonly maxTotalBytes: number;
  readonly maxEntries: number;
  readonly deleteTombstoneRetentionMs: number;
};

function validateStorageLimit(
  value: number,
  label: string,
  maximum = MAX_CONFIGURED_FILE_BYTES
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new StudioDraftPersistenceError(
      "studio_storage_invalid",
      `${label} must be a positive safe integer no larger than ${maximum} bytes`
    );
  }
  return value;
}

function validateTombstoneRetention(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TOMBSTONE_RETENTION_MS
  ) {
    throw new StudioDraftPersistenceError(
      "studio_storage_invalid",
      "deleteTombstoneRetentionMs must be a positive safe integer no larger than 7 days"
    );
  }
  return value;
}

function validateEntryLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CONFIGURED_ENTRIES
  ) {
    throw new StudioDraftPersistenceError(
      "studio_storage_invalid",
      `maxEntries must be a positive safe integer no larger than ${MAX_CONFIGURED_ENTRIES}`
    );
  }
  return value;
}

export function resolveStudioDraftStorageLimits(
  configured: Partial<StudioDraftStorageLimits> = {}
): ResolvedStudioDraftStorageLimits {
  const limits = {
    ...DEFAULT_STUDIO_DRAFT_STORAGE_LIMITS,
    ...configured
  };
  const maxBlobBytes = validateStorageLimit(
    limits.maxBlobBytes,
    "maxBlobBytes"
  );
  const maxChangeSetBytes = validateStorageLimit(
    limits.maxChangeSetBytes,
    "maxChangeSetBytes"
  );
  const maxTotalBytes = validateStorageLimit(
    limits.maxTotalBytes,
    "maxTotalBytes",
    MAX_CONFIGURED_TOTAL_BYTES
  );
  if (maxTotalBytes < Math.max(maxBlobBytes, maxChangeSetBytes)) {
    throw new StudioDraftPersistenceError(
      "studio_storage_invalid",
      "maxTotalBytes cannot be smaller than an individual file limit"
    );
  }
  return {
    blob: {
      maxBytes: maxBlobBytes,
      tooLargeCode: "studio_blob_too_large",
      label: "Studio blob"
    },
    changeSet: {
      maxBytes: maxChangeSetBytes,
      tooLargeCode: "studio_draft_too_large",
      label: "Studio change set"
    },
    maxTotalBytes,
    maxEntries: validateEntryLimit(limits.maxEntries),
    deleteTombstoneRetentionMs: validateTombstoneRetention(
      limits.deleteTombstoneRetentionMs
    )
  };
}

export function assertStudioPrivateFileSize(
  actualBytes: number,
  limit: StudioPrivateFileLimit
): void {
  if (actualBytes > limit.maxBytes) {
    throw new StudioDraftPersistenceError(
      limit.tooLargeCode,
      `${limit.label} exceeds the ${limit.maxBytes}-byte storage limit`,
      { details: { actualBytes, maxBytes: limit.maxBytes } }
    );
  }
}

export function assertStudioTotalStorageSize(
  actualBytes: number,
  maxBytes: number
): void {
  if (actualBytes > maxBytes) {
    throw new StudioDraftPersistenceError(
      "studio_storage_quota_exceeded",
      `Studio draft storage exceeds the ${maxBytes}-byte aggregate quota`,
      { details: { actualBytes, maxBytes } }
    );
  }
}
