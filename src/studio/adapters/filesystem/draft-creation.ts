import { rename } from "node:fs/promises";
import { StudioDraftPersistenceError } from "../../application/drafts/persistence.js";
import type { StudioChangeSet } from "../../contracts/drafts.js";
import type { PreparedStudioDraftBlob } from "./draft-blobs.js";
import { findStudioDraftTombstone } from "./draft-deletion.js";
import {
  assertStudioDraftBlobsAvailableAt,
  assertStudioDraftMutationFitsQuota,
  writeStudioDraftBlobs
} from "./draft-record-store.js";
import {
  assertStudioDraftStorage,
  ensureStudioDraftStorage,
  removePrivateEntry,
  studioDraftDirectory,
  studioDraftFilePath,
  studioDraftStagingName,
  syncPrivateDirectory,
  writePrivateFile,
  type StudioStorageLayout
} from "./private-storage.js";
import type { ResolvedStudioDraftStorageLimits } from "./storage-limits.js";

export type StudioDraftCreateFaultStage =
  | "after_create_staging"
  | "after_create_metadata"
  | "after_create_rename"
  | "after_create_directory_sync";

export async function createStudioDraft(input: {
  readonly layout: StudioStorageLayout;
  readonly limits: ResolvedStudioDraftStorageLimits;
  readonly changeSet: StudioChangeSet;
  readonly encodedDraft: string;
  readonly blobs: readonly PreparedStudioDraftBlob[];
  readonly faultInjector?: (
    stage: StudioDraftCreateFaultStage
  ) => Promise<void> | void;
}): Promise<void> {
  const draftId = input.changeSet.draft_id;
  if (
    (await assertStudioDraftStorage(input.layout, draftId)) ||
    (await findStudioDraftTombstone(
      input.layout,
      draftId,
      input.limits.maxEntries
    )) !== undefined
  ) {
    throw new StudioDraftPersistenceError(
      "studio_draft_already_exists",
      `Studio draft ${draftId} already exists`,
      { details: { draftId } }
    );
  }

  const stagingName = studioDraftStagingName(draftId);
  const stagingPath = studioDraftDirectory(input.layout, stagingName);
  await removePrivateEntry(stagingPath);
  await syncPrivateDirectory(input.layout.draftsRoot);
  await assertStudioDraftMutationFitsQuota({
    layout: input.layout,
    limits: input.limits,
    blobs: input.blobs,
    encodedDraft: input.encodedDraft,
    additionalEntries: 3 + input.blobs.length
  });
  await ensureStudioDraftStorage(input.layout, stagingName);

  let published = false;
  try {
    await input.faultInjector?.("after_create_staging");
    await writeStudioDraftBlobs(
      input.layout,
      input.limits.blob,
      stagingName,
      input.blobs
    );
    await assertStudioDraftBlobsAvailableAt(
      input.layout,
      input.limits.blob,
      stagingName,
      input.changeSet
    );
    await writePrivateFile(
      studioDraftFilePath(input.layout, stagingName),
      input.encodedDraft,
      input.limits.changeSet
    );
    await input.faultInjector?.("after_create_metadata");
    await rename(
      stagingPath,
      studioDraftDirectory(input.layout, draftId)
    );
    published = true;
    await input.faultInjector?.("after_create_rename");
    await syncPrivateDirectory(input.layout.draftsRoot);
    await input.faultInjector?.("after_create_directory_sync");
  } catch (cause) {
    if (published) {
      throw new StudioDraftPersistenceError(
        "studio_storage_commit_ambiguous",
        `Studio draft ${draftId} create may have committed`,
        { cause, details: { draftId } }
      );
    }
    await discardIncompleteCreate(
      input.layout,
      stagingName,
      draftId,
      cause
    );
    if (
      cause instanceof StudioDraftPersistenceError &&
      cause.code === "studio_storage_commit_ambiguous"
    ) {
      throw new StudioDraftPersistenceError(
        "studio_storage_io_failed",
        `Studio draft ${draftId} create did not commit`,
        { cause, details: { draftId } }
      );
    }
    throw cause;
  }
}

async function discardIncompleteCreate(
  layout: StudioStorageLayout,
  storageName: string,
  draftId: string,
  originalCause: unknown
): Promise<void> {
  try {
    await removePrivateEntry(studioDraftDirectory(layout, storageName));
    await syncPrivateDirectory(layout.draftsRoot);
  } catch (cleanupCause) {
    throw new StudioDraftPersistenceError(
      "studio_storage_io_failed",
      `Unable to roll back incomplete Studio draft ${draftId}`,
      { cause: { originalCause, cleanupCause }, details: { draftId } }
    );
  }
}
