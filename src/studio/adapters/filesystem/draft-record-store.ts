import { StudioDraftPersistenceError } from "../../application/drafts/persistence.js";
import type { StudioChangeSet } from "../../contracts/drafts.js";
import type { PreparedStudioDraftBlob } from "./draft-blobs.js";
import {
  decodeStoredStudioDraft,
  decodeStudioBlob,
  encodeStudioDraft,
  referencedStudioBlobDigests
} from "./draft-codec.js";
import {
  assertStudioDraftStorage,
  readPrivateFile,
  studioBlobFilePath,
  studioDraftFilePath,
  writePrivateFile,
  type StudioStorageLayout
} from "./private-storage.js";
import { measureStudioDraftStorage } from "./storage-maintenance.js";
import {
  assertStudioPrivateFileSize,
  assertStudioTotalStorageSize,
  type ResolvedStudioDraftStorageLimits,
  type StudioPrivateFileLimit
} from "./storage-limits.js";

export function encodeStudioDraftWithinLimit(
  changeSet: StudioChangeSet,
  limit: StudioPrivateFileLimit
): string {
  const encoded = encodeStudioDraft(changeSet);
  assertStudioPrivateFileSize(Buffer.byteLength(encoded, "utf8"), limit);
  return encoded;
}

export async function assertStudioDraftMutationFitsQuota(input: {
  readonly layout: StudioStorageLayout;
  readonly limits: ResolvedStudioDraftStorageLimits;
  readonly blobs: readonly PreparedStudioDraftBlob[];
  readonly encodedDraft: string;
  readonly additionalEntries: number;
}): Promise<void> {
  let additionalBytes = Buffer.byteLength(input.encodedDraft, "utf8");
  for (const blob of input.blobs) {
    additionalBytes += blob.bytes.byteLength;
  }
  const current = await measureStudioDraftStorage(
    input.layout,
    input.limits.maxEntries
  );
  assertStudioTotalStorageSize(
    current.bytes + additionalBytes,
    input.limits.maxTotalBytes
  );
  if (current.entries + input.additionalEntries > input.limits.maxEntries) {
    throw new StudioDraftPersistenceError(
      "studio_storage_quota_exceeded",
      "Studio draft mutation exceeds the storage entry quota",
      {
        details: {
          actualEntries: current.entries + input.additionalEntries,
          maxEntries: input.limits.maxEntries
        }
      }
    );
  }
}

export async function selectNewStudioDraftBlobs(
  layout: StudioStorageLayout,
  limit: StudioPrivateFileLimit,
  draftId: string,
  blobs: readonly PreparedStudioDraftBlob[]
): Promise<readonly PreparedStudioDraftBlob[]> {
  const missing: PreparedStudioDraftBlob[] = [];
  for (const blob of blobs) {
    const blobPath = studioBlobFilePath(layout, draftId, blob.digest);
    const existing = await readPrivateFile(blobPath, limit);
    if (existing !== undefined) {
      decodeStudioBlob(existing, blob.digest);
      continue;
    }
    missing.push(blob);
  }
  return missing;
}

export async function writeStudioDraftBlobs(
  layout: StudioStorageLayout,
  limit: StudioPrivateFileLimit,
  storageName: string,
  blobs: readonly PreparedStudioDraftBlob[]
): Promise<void> {
  for (const blob of blobs) {
    await writePrivateFile(
      studioBlobFilePath(layout, storageName, blob.digest),
      blob.bytes,
      limit
    );
  }
}

export async function readStudioDraftMetadata(
  layout: StudioStorageLayout,
  limit: StudioPrivateFileLimit,
  draftId: string
): Promise<StudioChangeSet | undefined> {
  if (!(await assertStudioDraftStorage(layout, draftId))) {
    return undefined;
  }
  const bytes = await readPrivateFile(
    studioDraftFilePath(layout, draftId),
    limit
  );
  return bytes === undefined
    ? undefined
    : decodeStoredStudioDraft(bytes, draftId);
}

export async function readStudioDraft(
  layout: StudioStorageLayout,
  limits: ResolvedStudioDraftStorageLimits,
  draftId: string
): Promise<StudioChangeSet | undefined> {
  const changeSet = await readStudioDraftMetadata(
    layout,
    limits.changeSet,
    draftId
  );
  if (changeSet !== undefined) {
    await assertStudioDraftBlobsAvailable(layout, limits.blob, changeSet);
  }
  return changeSet;
}

export async function assertStudioDraftBlobsAvailable(
  layout: StudioStorageLayout,
  limit: StudioPrivateFileLimit,
  changeSet: StudioChangeSet
): Promise<void> {
  await assertStudioDraftBlobsAvailableAt(
    layout,
    limit,
    changeSet.draft_id,
    changeSet
  );
}

export async function assertStudioDraftBlobsAvailableAt(
  layout: StudioStorageLayout,
  limit: StudioPrivateFileLimit,
  storageName: string,
  changeSet: StudioChangeSet
): Promise<void> {
  for (const digest of referencedStudioBlobDigests(changeSet)) {
    await readStudioDraftBlobAt(
      layout,
      limit,
      storageName,
      changeSet.draft_id,
      digest
    );
  }
}

export async function readStudioDraftBlob(
  layout: StudioStorageLayout,
  limit: StudioPrivateFileLimit,
  draftId: string,
  digest: string
): Promise<string> {
  return await readStudioDraftBlobAt(
    layout,
    limit,
    draftId,
    draftId,
    digest
  );
}

async function readStudioDraftBlobAt(
  layout: StudioStorageLayout,
  limit: StudioPrivateFileLimit,
  storageName: string,
  draftId: string,
  digest: string
): Promise<string> {
  if (!(await assertStudioDraftStorage(layout, storageName))) {
    throw new StudioDraftPersistenceError(
      "studio_blob_missing",
      `Studio blob ${digest} is missing`,
      { details: { digest, draftId } }
    );
  }
  const bytes = await readPrivateFile(
    studioBlobFilePath(layout, storageName, digest),
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
