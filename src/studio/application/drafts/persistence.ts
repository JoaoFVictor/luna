import type {
  StudioChangeSet,
  StudioDraftListPage
} from "../../contracts/drafts.js";
import type { StudioResourceRef } from "../../contracts/paths.js";

export type StudioDraftBlob = {
  readonly digest: string;
  readonly content: string;
};

export type StudioDraftCreate = {
  readonly changeSet: StudioChangeSet;
  readonly blobs: readonly StudioDraftBlob[];
};

export type StudioDraftVersion = {
  readonly recordRevision: number;
  readonly contentRevision: number;
  readonly layoutRevision: number;
};

export type StudioDraftUpdate = {
  readonly changeSet: StudioChangeSet;
  readonly expectedVersion: StudioDraftVersion;
  readonly blobs: readonly StudioDraftBlob[];
};

export type StudioDraftDelete = {
  readonly draftId: string;
  readonly expectedVersion: StudioDraftVersion;
};

export type StudioDraftRepositoryPort = {
  create(input: StudioDraftCreate): Promise<StudioChangeSet>;
  get(draftId: string): Promise<StudioChangeSet | undefined>;
  list(input?: StudioDraftListInput): Promise<StudioDraftListPage>;
  update(input: StudioDraftUpdate): Promise<StudioChangeSet>;
  delete(input: StudioDraftDelete): Promise<void>;
};

export type StudioDraftBlobReaderPort = {
  getBlob(
    draftId: string,
    digest: string,
    options: StudioDraftBlobReadOptions
  ): Promise<string>;
};

export type StudioDraftBlobReadOptions = {
  readonly maxBytes: number;
};

export type StudioDraftPersistencePort = StudioDraftRepositoryPort &
  StudioDraftBlobReaderPort;

export type StudioDraftListInput = {
  readonly cursor?: string;
  readonly limit?: number;
  /** Internal storage filter. Implementations must not expose skipped IDs in cursors or diagnostics. */
  readonly primaryResourceKinds?: readonly StudioResourceRef["kind"][];
};

export type StudioDraftLockRelease = () => Promise<void> | void;

/**
 * Implementations must coordinate every process that can mutate the same
 * Studio storage root. A process-local mutex is not sufficient.
 */
export type StudioDraftLockPort = {
  acquire(
    resource: string,
    mode: "exclusive"
  ):
    | Promise<StudioDraftLockRelease>
    | StudioDraftLockRelease;
};

export type StudioDraftPersistenceErrorCode =
  | "studio_draft_id_invalid"
  | "studio_draft_invalid"
  | "studio_draft_corrupt"
  | "studio_draft_not_found"
  | "studio_draft_already_exists"
  | "studio_draft_revision_conflict"
  | "studio_blob_digest_invalid"
  | "studio_blob_digest_mismatch"
  | "studio_blob_duplicate"
  | "studio_blob_unreferenced"
  | "studio_blob_content_invalid"
  | "studio_blob_too_large"
  | "studio_blob_missing"
  | "studio_blob_corrupt"
  | "studio_draft_too_large"
  | "studio_storage_quota_exceeded"
  | "studio_list_cursor_invalid"
  | "studio_list_limit_invalid"
  | "studio_storage_invalid"
  | "studio_storage_io_failed"
  | "studio_storage_commit_ambiguous";

export type StudioDraftPersistenceErrorDetails = {
  readonly draftId?: string;
  readonly digest?: string;
  readonly expectedVersion?: StudioDraftVersion;
  readonly actualVersion?: StudioDraftVersion;
  readonly actualBytes?: number;
  readonly maxBytes?: number;
  readonly actualEntries?: number;
  readonly maxEntries?: number;
};

export class StudioDraftPersistenceError extends Error {
  readonly code: StudioDraftPersistenceErrorCode;
  readonly details: StudioDraftPersistenceErrorDetails;

  constructor(
    code: StudioDraftPersistenceErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: StudioDraftPersistenceErrorDetails;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "StudioDraftPersistenceError";
    this.code = code;
    this.details = options.details ?? {};
  }
}
