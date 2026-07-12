import {
  StudioDraftPersistenceError,
  type StudioDraftCreate,
  type StudioDraftDelete,
  type StudioDraftListInput,
  type StudioDraftLockPort,
  type StudioDraftPersistencePort,
  type StudioDraftUpdate
} from "../../application/drafts/persistence.js";
import {
  assertStudioDraftCreateVersion,
  assertStudioDraftUpdate,
  assertStudioDraftVersionMatches,
  assertStudioExpectedVersion
} from "../../application/drafts/versioning.js";
import type {
  StudioChangeSet,
  StudioDraftListPage
} from "../../contracts/drafts.js";
import { prepareStudioDraftBlobs } from "./draft-blobs.js";
import {
  createStudioDraft,
  type StudioDraftCreateFaultStage
} from "./draft-creation.js";
import {
  assertStudioDraftTombstoneVersion,
  commitStudioDraftDelete,
  confirmStudioDraftDelete,
  findStudioDraftTombstone,
  type StudioDraftDeleteFaultStage
} from "./draft-deletion.js";
import {
  buildFilteredStudioDraftListPage,
  buildStudioDraftListPage,
  parseStudioDraftListQuery
} from "./draft-list.js";
import { readStudioDraftListEntry } from "./draft-list-read-model.js";
import {
  withExclusiveStudioDraftLock,
  type StudioDraftLockReleaseErrorReporter
} from "./draft-locking.js";
import {
  assertStudioDraftBlobsAvailable,
  assertStudioDraftMutationFitsQuota,
  encodeStudioDraftWithinLimit,
  readStudioDraft,
  readStudioDraftBlob,
  readStudioDraftMetadata,
  selectNewStudioDraftBlobs,
  writeStudioDraftBlobs
} from "./draft-record-store.js";
import {
  digestStudioBlob,
  normalizeStudioDraftInput,
  parseStudioBlobDigest,
  parseStudioDraftId
} from "./draft-codec.js";
import {
  assertStudioDraftStorage,
  createStudioStorageLayout,
  ensureStudioStorage,
  selectStudioDraftDirectoryNames,
  studioDraftFilePath,
  writePrivateFile,
  type StudioStorageLayout
} from "./private-storage.js";
import {
  collectStudioDraftGarbageForDraft,
  collectStudioDraftRootGarbage,
  type StudioDraftRootMaintenanceFaultStage
} from "./storage-maintenance.js";
import {
  resolveStudioDraftStorageLimits,
  type ResolvedStudioDraftStorageLimits,
  type StudioDraftStorageLimits
} from "./storage-limits.js";

export {
  DEFAULT_STUDIO_DRAFT_STORAGE_LIMITS,
  type StudioDraftStorageLimits
} from "./storage-limits.js";
export type { StudioDraftCreateFaultStage } from "./draft-creation.js";

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
  readonly onLockReleaseError?: StudioDraftLockReleaseErrorReporter;
};

const MAX_ROOT_MAINTENANCE_POLL_INTERVAL_MS = 60_000;

function missingDraft(draftId: string): StudioDraftPersistenceError {
  return new StudioDraftPersistenceError(
    "studio_draft_not_found",
    `Studio draft ${draftId} does not exist`,
    { details: { draftId } }
  );
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
    | StudioDraftLockReleaseErrorReporter
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
      return await readStudioDraftBlob(
        this.layout,
        readLimit,
        normalizedId,
        normalizedDigest
      );
    });
  }

  async create(input: StudioDraftCreate): Promise<StudioChangeSet> {
    const normalized = normalizeStudioDraftInput(input.changeSet);
    assertStudioDraftCreateVersion(normalized);
    const encoded = encodeStudioDraftWithinLimit(
      normalized,
      this.limits.changeSet
    );
    const blobs = prepareStudioDraftBlobs(
      normalized,
      input.blobs,
      this.limits.blob,
      this.limits.maxTotalBytes
    );

    return await this.withStorageLock(async () => {
      await this.maintainDraftIfPresent(normalized.draft_id);
      await createStudioDraft({
        layout: this.layout,
        limits: this.limits,
        changeSet: normalized,
        encodedDraft: encoded,
        blobs,
        faultInjector: this.createFaultInjector
      });
      return normalized;
    });
  }

  async get(draftId: string): Promise<StudioChangeSet | undefined> {
    const normalizedId = parseStudioDraftId(draftId);
    return await this.withStorageLock(async () => {
      await this.maintainDraftIfPresent(normalizedId);
      return await readStudioDraft(this.layout, this.limits, normalizedId);
    });
  }

  async list(input: StudioDraftListInput = {}): Promise<StudioDraftListPage> {
    return await this.withStorageLock(async () => {
      const query = parseStudioDraftListQuery(input);
      if (query.primaryResourceKinds !== undefined) {
        const directoryPage = await selectStudioDraftDirectoryNames({
          layout: this.layout,
          ...(query.after === undefined ? {} : { after: query.after }),
          limit: this.limits.maxEntries,
          maxEntries: this.limits.maxEntries
        });
        return await buildFilteredStudioDraftListPage({
          directoryNames: directoryPage.names,
          limit: query.limit,
          include: (summary) =>
            query.primaryResourceKinds!.has(summary.primary_resource.kind),
          readEntry: async (directoryName) =>
            await readStudioDraftListEntry(
              this.layout,
              this.limits.changeSet,
              directoryName
            )
        });
      }
      const directoryPage = await selectStudioDraftDirectoryNames({
        layout: this.layout,
        ...query,
        maxEntries: this.limits.maxEntries
      });
      return await buildStudioDraftListPage({
        directoryNames: directoryPage.names,
        hasMore: directoryPage.hasMore,
        readEntry: async (directoryName) =>
          await readStudioDraftListEntry(
            this.layout,
            this.limits.changeSet,
            directoryName
          )
      });
    }, { maintainRoot: false });
  }

  async update(input: StudioDraftUpdate): Promise<StudioChangeSet> {
    const normalized = normalizeStudioDraftInput(input.changeSet);
    const draftId = parseStudioDraftId(normalized.draft_id);
    const expectedVersion = { ...input.expectedVersion };
    assertStudioExpectedVersion(expectedVersion, draftId);
    const encoded = encodeStudioDraftWithinLimit(
      normalized,
      this.limits.changeSet
    );
    const blobs = prepareStudioDraftBlobs(
      normalized,
      input.blobs,
      this.limits.blob,
      this.limits.maxTotalBytes
    );

    return await this.withStorageLock(async () => {
      await this.maintainDraftIfPresent(draftId);
      const current = await readStudioDraftMetadata(
        this.layout,
        this.limits.changeSet,
        draftId
      );
      if (current === undefined) {
        throw missingDraft(draftId);
      }
      assertStudioDraftVersionMatches(current, expectedVersion);
      assertStudioDraftUpdate(current, normalized);
      const newBlobs = await selectNewStudioDraftBlobs(
        this.layout,
        this.limits.blob,
        draftId,
        blobs
      );
      await assertStudioDraftMutationFitsQuota({
        layout: this.layout,
        limits: this.limits,
        blobs: newBlobs,
        encodedDraft: encoded,
        additionalEntries: newBlobs.length + 1
      });
      await writeStudioDraftBlobs(
        this.layout,
        this.limits.blob,
        draftId,
        newBlobs
      );
      await assertStudioDraftBlobsAvailable(
        this.layout,
        this.limits.blob,
        normalized
      );
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
      const current = await readStudioDraftMetadata(
        this.layout,
        this.limits.changeSet,
        draftId
      );
      const tombstone = await findStudioDraftTombstone(
        this.layout,
        draftId,
        this.limits.maxEntries
      );
      if (current === undefined) {
        if (tombstone === undefined) {
          throw missingDraft(draftId);
        }
        await assertStudioDraftTombstoneVersion(
          tombstone,
          expectedVersion,
          this.limits.changeSet
        );
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
    return await withExclusiveStudioDraftLock({
      lockManager: this.lockManager,
      resource: this.draftLockResource,
      operation: async () => {
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
      },
      onReleaseError: this.onLockReleaseError
    });
  }
}
