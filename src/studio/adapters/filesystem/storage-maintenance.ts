import { lstat } from "node:fs/promises";
import path from "node:path";
import { StudioDraftPersistenceError } from "../../application/drafts/persistence.js";
import {
  decodeStoredStudioDraft,
  parseStudioDraftId,
  referencedStudioBlobDigests
} from "./draft-codec.js";
import { parseStudioDraftTombstoneName } from "./draft-deletion.js";
import {
  isStudioPrivateRemovalName,
  readPrivateFile,
  readBoundedPrivateDirectoryEntries,
  removePrivateEntry,
  studioPrivateEntryIdentity,
  studioDraftCreationMarkerPath,
  studioDraftFilePath,
  studioDraftFilesDirectory,
  studioDraftStagingName,
  syncPrivateDirectory,
  type StudioPrivateEntryIdentity,
  type StudioStorageLayout
} from "./private-storage.js";
import type { ResolvedStudioDraftStorageLimits } from "./storage-limits.js";

function invalidStorage(message: string, cause?: unknown): never {
  throw new StudioDraftPersistenceError("studio_storage_invalid", message, {
    cause
  });
}

async function entryMetadata(entryPath: string) {
  try {
    return await lstat(entryPath);
  } catch (cause) {
    throw new StudioDraftPersistenceError(
      "studio_storage_io_failed",
      "Unable to inspect Studio private storage",
      { cause }
    );
  }
}

async function realFileExists(filePath: string): Promise<boolean> {
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      invalidStorage("Studio private storage marker must be a real file");
    }
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    if (cause instanceof StudioDraftPersistenceError) {
      throw cause;
    }
    throw new StudioDraftPersistenceError(
      "studio_storage_io_failed",
      "Unable to inspect Studio private storage marker",
      { cause }
    );
  }
}

async function removeAndSync(
  entryPath: string,
  parentPath: string
): Promise<void> {
  await removePrivateEntry(entryPath);
  await syncPrivateDirectory(parentPath);
}

function isAtomicTempFor(name: string, targetName: string): boolean {
  return name.startsWith(`.${targetName}.`) && name.endsWith(".tmp");
}

async function draftRootEntries(
  draftDirectory: string,
  maxEntries: number
): Promise<readonly string[]> {
  return (
    await readBoundedPrivateDirectoryEntries(
      draftDirectory,
      maxEntries,
      "Studio draft storage"
    )
  ).map((entry) => entry.name);
}

async function removeDraftRootTemps(
  draftDirectory: string,
  entries: readonly string[]
): Promise<void> {
  const temporaryNames = entries.filter(
    (name) =>
      isAtomicTempFor(name, "change-set.json") ||
      isAtomicTempFor(name, ".creating") ||
      isStudioPrivateRemovalName(name)
  );
  for (const name of temporaryNames) {
    await removePrivateEntry(path.join(draftDirectory, name));
  }
  if (temporaryNames.length > 0) {
    await syncPrivateDirectory(draftDirectory);
  }
}

async function collectDraftBlobGarbage(input: {
  readonly layout: StudioStorageLayout;
  readonly draftId: string;
  readonly referencedDigests: readonly string[];
  readonly maxEntries: number;
}): Promise<void> {
  const filesDirectory = studioDraftFilesDirectory(
    input.layout,
    input.draftId
  );
  const entries = await readBoundedPrivateDirectoryEntries(
    filesDirectory,
    input.maxEntries,
    "Studio draft blobs"
  );
  const referencedNames = new Set(
    input.referencedDigests.map((digest) => digest.slice("sha256:".length))
  );
  let removed = false;
  for (const entry of entries) {
    if (referencedNames.has(entry.name)) {
      continue;
    }
    await removePrivateEntry(path.join(filesDirectory, entry.name));
    removed = true;
  }
  if (removed) {
    await syncPrivateDirectory(filesDirectory, "Studio draft files directory");
  }
}

export async function collectStudioDraftGarbageForDraft(input: {
  readonly layout: StudioStorageLayout;
  readonly draftId: string;
  readonly limits: ResolvedStudioDraftStorageLimits;
}): Promise<void> {
  const draftPath = studioDraftFilePath(input.layout, input.draftId);
  const markerPath = studioDraftCreationMarkerPath(
    input.layout,
    input.draftId
  );
  const draftDirectory = path.dirname(draftPath);
  const rootEntries = await draftRootEntries(
    draftDirectory,
    input.limits.maxEntries
  );
  const bytes = await readPrivateFile(draftPath, input.limits.changeSet);
  if (bytes === undefined) {
    if (
      (await realFileExists(markerPath)) ||
      rootEntries.some((name) => isAtomicTempFor(name, ".creating"))
    ) {
      await removeAndSync(draftDirectory, input.layout.draftsRoot);
    }
    return;
  }

  await removeDraftRootTemps(draftDirectory, rootEntries);

  let changeSet;
  try {
    changeSet = decodeStoredStudioDraft(bytes, input.draftId);
  } catch {
    // Corrupt metadata remains visible to list() as a per-draft diagnostic.
    return;
  }
  if (await realFileExists(markerPath)) {
    await removePrivateEntry(markerPath);
    await syncPrivateDirectory(draftDirectory);
  }
  await collectDraftBlobGarbage({
    layout: input.layout,
    draftId: input.draftId,
    referencedDigests: referencedStudioBlobDigests(changeSet),
    maxEntries: input.limits.maxEntries
  });
}

function isStudioDraftStagingName(name: string): boolean {
  if (!name.startsWith(".creating-")) {
    return false;
  }
  try {
    return studioDraftStagingName(
      parseStudioDraftId(name.slice(".creating-".length))
    ) === name;
  } catch {
    return false;
  }
}

async function assertRealMaintenanceDirectory(
  entryPath: string,
  entryIsDirectory: boolean,
  entryIsSymbolicLink: boolean
): Promise<StudioPrivateEntryIdentity> {
  if (!entryIsDirectory || entryIsSymbolicLink) {
    invalidStorage("Studio maintenance target must be a real directory");
  }
  const metadata = await entryMetadata(entryPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    invalidStorage("Studio maintenance target changed while being inspected");
  }
  return studioPrivateEntryIdentity(metadata);
}

export type StudioDraftRootMaintenanceFaultStage =
  | "after_root_entry_inspected";

export type StudioDraftRootMaintenanceResult = {
  readonly nextMaintenanceAtMs: number | null;
};

function tombstoneExpiryMs(
  deletedAtMs: number,
  retentionMs: number
): number {
  return Math.min(Number.MAX_SAFE_INTEGER, deletedAtMs + retentionMs);
}

export async function collectStudioDraftRootGarbage(input: {
  readonly layout: StudioStorageLayout;
  readonly limits: ResolvedStudioDraftStorageLimits;
  readonly nowMs: number;
  readonly faultInjector?: (
    stage: StudioDraftRootMaintenanceFaultStage,
    context: { readonly entryPath: string }
  ) => Promise<void> | void;
}): Promise<StudioDraftRootMaintenanceResult> {
  let rootChanged = false;
  let nextMaintenanceAtMs: number | null = null;
  const entries = await readBoundedPrivateDirectoryEntries(
    input.layout.draftsRoot,
    input.limits.maxEntries,
    "Studio drafts directory"
  );
  for (const entry of entries) {
    const tombstone = parseStudioDraftTombstoneName(entry.name);
    const removeStaging =
      isStudioDraftStagingName(entry.name) ||
      isStudioPrivateRemovalName(entry.name);
    const expiry =
      tombstone === undefined
        ? undefined
        : tombstoneExpiryMs(
            tombstone.deletedAtMs,
            input.limits.deleteTombstoneRetentionMs
          );
    const removeTombstone =
      expiry !== undefined && input.nowMs >= expiry;
    if (expiry !== undefined && !removeTombstone) {
      nextMaintenanceAtMs =
        nextMaintenanceAtMs === null
          ? expiry
          : Math.min(nextMaintenanceAtMs, expiry);
    }
    if (!removeStaging && !removeTombstone) {
      continue;
    }
    const entryPath = path.join(input.layout.draftsRoot, entry.name);
    const expectedIdentity = await assertRealMaintenanceDirectory(
      entryPath,
      entry.isDirectory(),
      entry.isSymbolicLink()
    );
    await input.faultInjector?.("after_root_entry_inspected", { entryPath });
    await removePrivateEntry(entryPath, { expectedIdentity });
    rootChanged = true;
  }

  if (rootChanged) {
    await syncPrivateDirectory(input.layout.draftsRoot);
  }
  return { nextMaintenanceAtMs };
}

type StorageEntryBudget = {
  actual: number;
  readonly max: number;
};

function accountStorageEntry(budget: StorageEntryBudget): void {
  budget.actual += 1;
  if (budget.actual > budget.max) {
    throw new StudioDraftPersistenceError(
      "studio_storage_quota_exceeded",
      "Studio draft storage contains too many entries",
      {
        details: {
          actualEntries: budget.actual,
          maxEntries: budget.max
        }
      }
    );
  }
}

async function measureEntry(
  entryPath: string,
  budget: StorageEntryBudget,
  countEntry: boolean
): Promise<number> {
  if (countEntry) {
    accountStorageEntry(budget);
  }
  const metadata = await entryMetadata(entryPath);
  if (metadata.isSymbolicLink()) {
    invalidStorage("Studio private storage cannot contain symbolic links");
  }
  if (metadata.isFile()) {
    return metadata.size;
  }
  if (!metadata.isDirectory()) {
    invalidStorage("Studio private storage contains an unsupported entry");
  }
  const entries = await readBoundedPrivateDirectoryEntries(
    entryPath,
    budget.max,
    "Studio draft storage quota scan"
  );
  let total = 0;
  for (const entry of entries) {
    total += await measureEntry(
      path.join(entryPath, entry.name),
      budget,
      true
    );
  }
  return total;
}

export type StudioDraftStorageMeasurement = {
  readonly bytes: number;
  readonly entries: number;
};

export async function measureStudioDraftStorage(
  layout: StudioStorageLayout,
  maxEntries: number
): Promise<StudioDraftStorageMeasurement> {
  const budget = { actual: 0, max: maxEntries };
  const bytes = await measureEntry(
    layout.draftsRoot,
    budget,
    false
  );
  return { bytes, entries: budget.actual };
}
