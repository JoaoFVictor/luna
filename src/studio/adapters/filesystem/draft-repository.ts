import path from "node:path";
import { rename } from "node:fs/promises";
import {
  StudioDraftPersistenceError,
  type StudioDraftCreate,
  type StudioDraftDelete,
  type StudioDraftListInput,
  type StudioDraftLockPort,
  type StudioDraftPersistencePort,
  type StudioDraftUpdate,
  type StudioDraftVersion
} from "../../application/drafts/persistence.js";
import {
  assertStudioDraftCreateVersion,
  assertStudioDraftUpdate,
  assertStudioDraftVersionMatches,
  assertStudioExpectedVersion,
  studioDraftVersion
} from "../../application/drafts/versioning.js";
import type {
  StudioChangeSet,
  StudioDraftListDiagnostic,
  StudioDraftListPage
} from "../../contracts/drafts.js";
import {
  prepareStudioDraftBlobs,
  type PreparedStudioDraftBlob
} from "./draft-blobs.js";
import {
  commitStudioDraftDelete,
  confirmStudioDraftDelete,
  findStudioDraftTombstone,
  type StudioDraftDeleteFaultStage
} from "./draft-deletion.js";
import {
  buildStudioDraftListPage,
  parseStudioDraftListQuery,
  type StudioDraftListEntry
} from "./draft-list.js";
import {
  decodeStoredStudioDraft,
  decodeStudioBlob,
  digestStudioBlob,
  encodeStudioDraft,
  normalizeStudioDraftInput,
  parseStudioBlobDigest,
  parseStudioDraftId,
  referencedStudioBlobDigests,
  toStudioDraftSummary
} from "./draft-codec.js";
import {
  assertStudioDraftStorage,
  createStudioStorageLayout,
  ensureStudioDraftStorage,
  ensureStudioStorage,
  selectStudioDraftDirectoryNames,
  readPrivateFile,
  removePrivateEntry,
  studioBlobFilePath,
  studioDraftDirectory,
  studioDraftFilePath,
  studioDraftStagingName,
  syncPrivateDirectory,
  writePrivateFile,
  type StudioStorageLayout
} from "./private-storage.js";
import {
  collectStudioDraftGarbageForDraft,
  collectStudioDraftRootGarbage,
  measureStudioDraftStorage,
  type StudioDraftRootMaintenanceFaultStage
} from "./storage-maintenance.js";
import {
  assertStudioPrivateFileSize,
  assertStudioTotalStorageSize,
  resolveStudioDraftStorageLimits,
  type ResolvedStudioDraftStorageLimits,
  type StudioDraftStorageLimits
} from "./storage-limits.js";

export {
  DEFAULT_STUDIO_DRAFT_STORAGE_LIMITS,
  type StudioDraftStorageLimits
} from "./storage-limits.js";

export type FileSystemStudioDraftRepositoryOptions = {
  readonly projectRoot: string;
  readonly lockManager: StudioDraftLockPort;
  readonly limits?: Partial<StudioDraftStorageLimits>;
  readonly now?: () => number;
  readonly deleteFaultInjector?: (
    stage: StudioDraftDeleteFaultStage
  ) => Promise<void> | void;
  readonly createFaultInjector?: (
    stage: StudioDraftCreateFaultStage
  ) => Promise<void> | void;
  readonly rootMaintenanceFaultInjector?: (
    stage: StudioDraftRootMaintenanceFaultStage,
    context: { readonly entryPath: string }
  ) => Promise<void> | void;
  /**
   * Audit-only notification. A lock release happens after the protected
   * operation has produced its outcome, so callback and release failures can
   * never change that outcome.
   */
  readonly onLockReleaseError?: (
    error: unknown,
    context: {
      readonly resource: string;
      readonly operationSucceeded: boolean;
    }
  ) => Promise<void> | void;
};

export type StudioDraftCreateFaultStage =
  | "after_create_staging"
  | "after_create_metadata"
  | "after_create_rename"
  | "after_create_directory_sync";

const MAX_ROOT_MAINTENANCE_POLL_INTERVAL_MS = 60_000;

function missingDraft(draftId: string): StudioDraftPersistenceError {
  return new StudioDraftPersistenceError(
    "studio_draft_not_found",
    `Studio draft ${draftId} does not exist`,
    { details: { draftId } }
  );
}

function sameVersion(
  left: StudioDraftVersion,
  right: StudioDraftVersion
): boolean {
  return (
    left.recordRevision === right.recordRevision &&
    left.contentRevision === right.contentRevision &&
    left.layoutRevision === right.layoutRevision
  );
}

function revisionConflict(
  draftId: string,
  expectedVersion: StudioDraftVersion,
  actualVersion: StudioDraftVersion
): StudioDraftPersistenceError {
  return new StudioDraftPersistenceError(
    "studio_draft_revision_conflict",
    `Studio draft ${draftId} was updated by another writer`,
    {
      details: { draftId, expectedVersion, actualVersion }
    }
  );
}

function listDiagnostic(
  draftId: string | null,
  cause: unknown
): StudioDraftListDiagnostic {
  const persistenceError =
    cause instanceof StudioDraftPersistenceError ? cause : undefined;
  const code =
    persistenceError?.code === "studio_draft_corrupt" ||
    persistenceError?.code === "studio_storage_invalid" ||
    persistenceError?.code === "studio_draft_too_large" ||
    persistenceError?.code === "studio_storage_io_failed"
      ? persistenceError.code
      : "studio_draft_corrupt";
  return {
    draft_id: draftId,
    code,
    message:
      code === "studio_draft_too_large"
        ? "Draft metadata exceeds its configured size limit."
        : code === "studio_storage_io_failed"
          ? "Draft metadata could not be read."
          : code === "studio_storage_invalid"
            ? "Draft storage layout is invalid."
            : "Draft metadata is corrupt."
  };
}

export class FileSystemStudioDraftRepository
  implements StudioDraftPersistencePort
{
  private readonly layout: StudioStorageLayout;
  private readonly lockManager: StudioDraftLockPort;
  private readonly draftLockResource: string;
  private readonly limits: ResolvedStudioDraftStorageLimits;
  private readonly now: () => number;
  private readonly deleteFaultInjector:
    | ((stage: StudioDraftDeleteFaultStage) => Promise<void> | void)
    | undefined;
  private readonly createFaultInjector:
    | ((stage: StudioDraftCreateFaultStage) => Promise<void> | void)
    | undefined;
  private readonly rootMaintenanceFaultInjector:
    | ((
        stage: StudioDraftRootMaintenanceFaultStage,
        context: { readonly entryPath: string }
      ) => Promise<void> | void)
    | undefined;
  private readonly onLockReleaseError:
    | ((
        error: unknown,
        context: {
          readonly resource: string;
          readonly operationSucceeded: boolean;
        }
      ) => Promise<void> | void)
    | undefined;
  private nextRootMaintenanceAtMs = 0;

  constructor(options: FileSystemStudioDraftRepositoryOptions) {
    if (options.projectRoot.trim() === "") {
      throw new StudioDraftPersistenceError(
        "studio_storage_invalid",
        "Studio project root cannot be empty"
      );
    }
    this.layout = createStudioStorageLayout(options.projectRoot);
    this.lockManager = options.lockManager;
    this.limits = resolveStudioDraftStorageLimits(options.limits);
    this.now = options.now ?? Date.now;
    this.deleteFaultInjector = options.deleteFaultInjector;
    this.createFaultInjector = options.createFaultInjector;
    this.rootMaintenanceFaultInjector = options.rootMaintenanceFaultInjector;
    this.onLockReleaseError = options.onLockReleaseError;
    const storageKey = digestStudioBlob(
      Buffer.from(this.layout.projectRoot, "utf8")
    ).slice("sha256:".length, "sha256:".length + 16);
    this.draftLockResource = `studio-drafts-${storageKey}`;
  }

  async getBlob(
    draftId: string,
    digest: string,
    options: { readonly maxBytes: number }
  ): Promise<string> {
    const normalizedId = parseStudioDraftId(draftId);
    const normalizedDigest = parseStudioBlobDigest(digest);
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new StudioDraftPersistenceError(
        "studio_storage_invalid",
        "Studio blob read limit must be a positive safe integer"
      );
    }
    const readLimit = {
      ...this.limits.blob,
      maxBytes: Math.min(this.limits.blob.maxBytes, options.maxBytes)
    };
    return await this.withStorageLock(async () => {
      await this.maintainDraftIfPresent(normalizedId);
      return await this.readBlob(normalizedId, normalizedDigest, readLimit);
    });
  }

  async create(input: StudioDraftCreate): Promise<StudioChangeSet> {
    const normalized = normalizeStudioDraftInput(input.changeSet);
    assertStudioDraftCreateVersion(normalized);
    const encoded = this.encodeWithinLimit(normalized);
    const blobs = prepareStudioDraftBlobs(
      normalized,
      input.blobs,
      this.limits.blob,
      this.limits.maxTotalBytes
    );

    return await this.withStorageLock(async () => {
      await this.maintainDraftIfPresent(normalized.draft_id);
      if (
        (await assertStudioDraftStorage(
          this.layout,
          normalized.draft_id
        )) ||
        (await findStudioDraftTombstone(
          this.layout,
          normalized.draft_id,
          this.limits.maxEntries
        )) !== undefined
      ) {
        throw new StudioDraftPersistenceError(
          "studio_draft_already_exists",
          `Studio draft ${normalized.draft_id} already exists`,
          { details: { draftId: normalized.draft_id } }
        );
      }
      const stagingName = studioDraftStagingName(normalized.draft_id);
      const stagingPath = studioDraftDirectory(this.layout, stagingName);
      await removePrivateEntry(stagingPath);
      await syncPrivateDirectory(this.layout.draftsRoot);
      await this.assertMutationFitsQuota(blobs, encoded, 3 + blobs.length);
      await ensureStudioDraftStorage(this.layout, stagingName);
      let published = false;
      try {
        await this.createFaultInjector?.("after_create_staging");
        await this.writeBlobs(stagingName, blobs);
        await this.assertBlobsAvailableAt(stagingName, normalized);
        await writePrivateFile(
          studioDraftFilePath(this.layout, stagingName),
          encoded,
          this.limits.changeSet
        );
        await this.createFaultInjector?.("after_create_metadata");
        await rename(
          stagingPath,
          studioDraftDirectory(this.layout, normalized.draft_id)
        );
        published = true;
        await this.createFaultInjector?.("after_create_rename");
        await syncPrivateDirectory(this.layout.draftsRoot);
        await this.createFaultInjector?.("after_create_directory_sync");
      } catch (cause) {
        if (published) {
          throw new StudioDraftPersistenceError(
            "studio_storage_commit_ambiguous",
            `Studio draft ${normalized.draft_id} create may have committed`,
            { cause, details: { draftId: normalized.draft_id } }
          );
        }
        await this.discardIncompleteCreate(
          stagingName,
          normalized.draft_id,
          cause
        );
        if (
          cause instanceof StudioDraftPersistenceError &&
          cause.code === "studio_storage_commit_ambiguous"
        ) {
          throw new StudioDraftPersistenceError(
            "studio_storage_io_failed",
            `Studio draft ${normalized.draft_id} create did not commit`,
            { cause, details: { draftId: normalized.draft_id } }
          );
        }
        throw cause;
      }
      return normalized;
    });
  }

  async get(draftId: string): Promise<StudioChangeSet | undefined> {
    const normalizedId = parseStudioDraftId(draftId);
    return await this.withStorageLock(async () => {
      await this.maintainDraftIfPresent(normalizedId);
      return await this.readDraft(normalizedId);
    });
  }

  async list(input: StudioDraftListInput = {}): Promise<StudioDraftListPage> {
    return await this.withStorageLock(async () => {
      const query = parseStudioDraftListQuery(input);
      const directoryPage = await selectStudioDraftDirectoryNames({
        layout: this.layout,
        ...query,
        maxEntries: this.limits.maxEntries
      });
      return await buildStudioDraftListPage({
        directoryNames: directoryPage.names,
        hasMore: directoryPage.hasMore,
        readEntry: async (directoryName) =>
          await this.readListEntry(directoryName)
      });
    }, { maintainRoot: false });
  }

  async update(input: StudioDraftUpdate): Promise<StudioChangeSet> {
    const normalized = normalizeStudioDraftInput(input.changeSet);
    const draftId = parseStudioDraftId(normalized.draft_id);
    const expectedVersion = { ...input.expectedVersion };
    assertStudioExpectedVersion(expectedVersion, draftId);
    const encoded = this.encodeWithinLimit(normalized);
    const blobs = prepareStudioDraftBlobs(
      normalized,
      input.blobs,
      this.limits.blob,
      this.limits.maxTotalBytes
    );

    return await this.withStorageLock(async () => {
      await this.maintainDraftIfPresent(draftId);
      const current = await this.readDraftMetadata(draftId);
      if (current === undefined) {
        throw missingDraft(draftId);
      }
      assertStudioDraftVersionMatches(current, expectedVersion);
      assertStudioDraftUpdate(current, normalized);
      const newBlobs = await this.selectNewBlobs(draftId, blobs);
      await this.assertMutationFitsQuota(
        newBlobs,
        encoded,
        newBlobs.length + 1
      );
      await this.writeBlobs(draftId, newBlobs);
      await this.assertBlobsAvailable(normalized);
      await writePrivateFile(
        studioDraftFilePath(this.layout, draftId),
        encoded,
        this.limits.changeSet
      );
      return normalized;
    });
  }

  async delete(input: StudioDraftDelete): Promise<void> {
    const draftId = parseStudioDraftId(input.draftId);
    const expectedVersion = { ...input.expectedVersion };
    assertStudioExpectedVersion(expectedVersion, draftId);

    await this.withStorageLock(async () => {
      await this.maintainDraftIfPresent(draftId);
      const current = await this.readDraftMetadata(draftId);
      const tombstone = await findStudioDraftTombstone(
        this.layout,
        draftId,
        this.limits.maxEntries
      );
      if (current === undefined) {
        if (tombstone === undefined) {
          throw missingDraft(draftId);
        }
        const tombstoneVersion = await this.readTombstoneVersion(tombstone);
        if (!sameVersion(tombstoneVersion, expectedVersion)) {
          throw revisionConflict(
            draftId,
            expectedVersion,
            tombstoneVersion
          );
        }
        await confirmStudioDraftDelete(this.layout, draftId);
        return;
      }
      if (tombstone !== undefined) {
        throw new StudioDraftPersistenceError(
          "studio_storage_invalid",
          `Studio draft ${draftId} exists alongside a deletion tombstone`,
          { details: { draftId } }
        );
      }
      assertStudioDraftVersionMatches(current, expectedVersion);
      const deletedAtMs = this.currentTimeMs();
      this.scheduleRootMaintenanceForTombstone(deletedAtMs);
      await commitStudioDraftDelete({
        layout: this.layout,
        draftId,
        version: expectedVersion,
        deletedAtMs,
        faultInjector: this.deleteFaultInjector
      });
    });
  }

  private encodeWithinLimit(changeSet: StudioChangeSet): string {
    const encoded = encodeStudioDraft(changeSet);
    assertStudioPrivateFileSize(
      Buffer.byteLength(encoded, "utf8"),
      this.limits.changeSet
    );
    return encoded;
  }

  private async maintainDraftIfPresent(draftId: string): Promise<void> {
    if (!(await assertStudioDraftStorage(this.layout, draftId))) {
      return;
    }
    await collectStudioDraftGarbageForDraft({
      layout: this.layout,
      draftId,
      limits: this.limits
    });
  }

  private async assertMutationFitsQuota(
    blobs: readonly PreparedStudioDraftBlob[],
    encodedDraft: string,
    additionalEntries: number
  ): Promise<void> {
    let additionalBytes = Buffer.byteLength(encodedDraft, "utf8");
    for (const blob of blobs) {
      additionalBytes += blob.bytes.byteLength;
    }
    const current = await measureStudioDraftStorage(
      this.layout,
      this.limits.maxEntries
    );
    assertStudioTotalStorageSize(
      current.bytes + additionalBytes,
      this.limits.maxTotalBytes
    );
    if (current.entries + additionalEntries > this.limits.maxEntries) {
      throw new StudioDraftPersistenceError(
        "studio_storage_quota_exceeded",
        "Studio draft mutation exceeds the storage entry quota",
        {
          details: {
            actualEntries: current.entries + additionalEntries,
            maxEntries: this.limits.maxEntries
          }
        }
      );
    }
  }

  private async selectNewBlobs(
    draftId: string,
    blobs: readonly PreparedStudioDraftBlob[]
  ): Promise<readonly PreparedStudioDraftBlob[]> {
    const missing: PreparedStudioDraftBlob[] = [];
    for (const blob of blobs) {
      const blobPath = studioBlobFilePath(this.layout, draftId, blob.digest);
      const existing = await readPrivateFile(blobPath, this.limits.blob);
      if (existing !== undefined) {
        decodeStudioBlob(existing, blob.digest);
        continue;
      }
      missing.push(blob);
    }
    return missing;
  }

  private async writeBlobs(
    draftId: string,
    blobs: readonly PreparedStudioDraftBlob[]
  ): Promise<void> {
    for (const blob of blobs) {
      await writePrivateFile(
        studioBlobFilePath(this.layout, draftId, blob.digest),
        blob.bytes,
        this.limits.blob
      );
    }
  }

  private async readDraftMetadata(
    draftId: string
  ): Promise<StudioChangeSet | undefined> {
    if (!(await assertStudioDraftStorage(this.layout, draftId))) {
      return undefined;
    }
    const bytes = await readPrivateFile(
      studioDraftFilePath(this.layout, draftId),
      this.limits.changeSet
    );
    return bytes === undefined
      ? undefined
      : decodeStoredStudioDraft(bytes, draftId);
  }

  private async readDraft(
    draftId: string
  ): Promise<StudioChangeSet | undefined> {
    const changeSet = await this.readDraftMetadata(draftId);
    if (changeSet !== undefined) {
      await this.assertBlobsAvailable(changeSet);
    }
    return changeSet;
  }

  private async assertBlobsAvailable(
    changeSet: StudioChangeSet
  ): Promise<void> {
    await this.assertBlobsAvailableAt(changeSet.draft_id, changeSet);
  }

  private async assertBlobsAvailableAt(
    storageName: string,
    changeSet: StudioChangeSet
  ): Promise<void> {
    for (const digest of referencedStudioBlobDigests(changeSet)) {
      await this.readBlobAt(storageName, changeSet.draft_id, digest);
    }
  }

  private async readBlob(
    draftId: string,
    digest: string,
    limit = this.limits.blob
  ): Promise<string> {
    return await this.readBlobAt(draftId, draftId, digest, limit);
  }

  private async readBlobAt(
    storageName: string,
    draftId: string,
    digest: string,
    limit = this.limits.blob
  ): Promise<string> {
    if (!(await assertStudioDraftStorage(this.layout, storageName))) {
      throw new StudioDraftPersistenceError(
        "studio_blob_missing",
        `Studio blob ${digest} is missing`,
        { details: { digest, draftId } }
      );
    }
    const bytes = await readPrivateFile(
      studioBlobFilePath(this.layout, storageName, digest),
      limit
    );
    if (bytes === undefined) {
      throw new StudioDraftPersistenceError(
        "studio_blob_missing",
        `Studio blob ${digest} is missing`,
        { details: { digest, draftId } }
      );
    }
    return decodeStudioBlob(bytes, digest);
  }

  private async readListEntry(
    directoryName: string
  ): Promise<StudioDraftListEntry> {
    let draftId: string;
    try {
      draftId = parseStudioDraftId(directoryName);
    } catch (cause) {
      return {
        kind: "diagnostic",
        value: listDiagnostic(
          null,
          new StudioDraftPersistenceError(
            "studio_storage_invalid",
            "Studio draft directory name is invalid",
            { cause }
          )
        )
      };
    }
    try {
      const changeSet = await this.readDraftMetadata(draftId);
      if (changeSet === undefined) {
        return {
          kind: "diagnostic",
          value: listDiagnostic(
            draftId,
            new StudioDraftPersistenceError(
              "studio_draft_corrupt",
              "Draft metadata is missing"
            )
          )
        };
      }
      return { kind: "summary", value: toStudioDraftSummary(changeSet) };
    } catch (cause) {
      return { kind: "diagnostic", value: listDiagnostic(draftId, cause) };
    }
  }

  private async readTombstoneVersion(tombstone: {
    readonly draftId: string;
    readonly path: string;
    readonly version: StudioDraftVersion;
  }): Promise<StudioDraftVersion> {
    const bytes = await readPrivateFile(
      path.join(tombstone.path, "change-set.json"),
      this.limits.changeSet
    );
    if (bytes === undefined) {
      throw new StudioDraftPersistenceError(
        "studio_storage_invalid",
        `Studio draft ${tombstone.draftId} tombstone has no metadata`,
        { details: { draftId: tombstone.draftId } }
      );
    }
    const embeddedVersion = studioDraftVersion(
      decodeStoredStudioDraft(bytes, tombstone.draftId)
    );
    if (!sameVersion(embeddedVersion, tombstone.version)) {
      throw new StudioDraftPersistenceError(
        "studio_storage_invalid",
        `Studio draft ${tombstone.draftId} tombstone version is inconsistent`,
        { details: { draftId: tombstone.draftId } }
      );
    }
    return embeddedVersion;
  }

  private async discardIncompleteCreate(
    storageName: string,
    draftId: string,
    originalCause: unknown
  ): Promise<void> {
    try {
      await removePrivateEntry(studioDraftDirectory(this.layout, storageName));
      await syncPrivateDirectory(this.layout.draftsRoot);
    } catch (cleanupCause) {
      throw new StudioDraftPersistenceError(
        "studio_storage_io_failed",
        `Unable to roll back incomplete Studio draft ${draftId}`,
        { cause: { originalCause, cleanupCause }, details: { draftId } }
      );
    }
  }

  private currentTimeMs(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new StudioDraftPersistenceError(
        "studio_storage_invalid",
        "Studio storage clock must return a non-negative safe integer"
      );
    }
    return value;
  }

  private scheduleRootMaintenanceForTombstone(deletedAtMs: number): void {
    const expiry = Math.min(
      Number.MAX_SAFE_INTEGER,
      deletedAtMs + this.limits.deleteTombstoneRetentionMs
    );
    this.nextRootMaintenanceAtMs = Math.min(
      this.nextRootMaintenanceAtMs,
      expiry
    );
  }

  private nextPeriodicRootMaintenanceAt(nowMs: number): number {
    const intervalMs = Math.min(
      this.limits.deleteTombstoneRetentionMs,
      MAX_ROOT_MAINTENANCE_POLL_INTERVAL_MS
    );
    return Math.min(Number.MAX_SAFE_INTEGER, nowMs + intervalMs);
  }

  private async withStorageLock<T>(
    operation: () => Promise<T>,
    options: { readonly maintainRoot?: boolean } = {}
  ): Promise<T> {
    await ensureStudioStorage(this.layout);
    return await this.withExclusiveLock(
      this.draftLockResource,
      async () => {
        const maintenanceDueAt = this.nextRootMaintenanceAtMs;
        if (options.maintainRoot !== false) {
          const nowMs = this.currentTimeMs();
          if (nowMs >= maintenanceDueAt) {
            const maintenance = await collectStudioDraftRootGarbage({
              layout: this.layout,
              limits: this.limits,
              nowMs,
              faultInjector: this.rootMaintenanceFaultInjector
            });
            const periodicMaintenanceAt =
              this.nextPeriodicRootMaintenanceAt(nowMs);
            this.nextRootMaintenanceAtMs =
              maintenance.nextMaintenanceAtMs === null
                ? periodicMaintenanceAt
                : Math.min(
                    maintenance.nextMaintenanceAtMs,
                    periodicMaintenanceAt
                  );
          }
        }
        return await operation();
      }
    );
  }

  private async withExclusiveLock<T>(
    resource: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const release = await this.lockManager.acquire(resource, "exclusive");
    let outcome:
      | { readonly succeeded: true; readonly value: T }
      | { readonly succeeded: false; readonly error: unknown };
    try {
      outcome = { succeeded: true, value: await operation() };
    } catch (cause) {
      outcome = { succeeded: false, error: cause };
    }

    try {
      await release();
    } catch (releaseError) {
      this.reportLockReleaseError(releaseError, {
        resource,
        operationSucceeded: outcome.succeeded
      });
    }

    if (!outcome.succeeded) {
      throw outcome.error;
    }
    return outcome.value;
  }

  private reportLockReleaseError(
    error: unknown,
    context: {
      readonly resource: string;
      readonly operationSucceeded: boolean;
    }
  ): void {
    try {
      const notification = this.onLockReleaseError?.(error, context);
      if (notification !== undefined) {
        void Promise.resolve(notification).catch(() => undefined);
      }
    } catch {
      // Audit sinks are deliberately best-effort at this boundary. A callback
      // failure cannot rewrite an already completed storage outcome.
    }
  }
}
