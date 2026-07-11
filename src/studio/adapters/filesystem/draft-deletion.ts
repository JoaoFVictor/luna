import { lstat, rename } from "node:fs/promises";
import path from "node:path";
import {
  StudioDraftPersistenceError,
  type StudioDraftVersion
} from "../../application/drafts/persistence.js";
import {
  readBoundedPrivateDirectoryEntries,
  studioDraftDirectory,
  syncPrivateDirectory,
  type StudioStorageLayout
} from "./private-storage.js";
import { parseStudioDraftId } from "./draft-codec.js";

const TOMBSTONE_PATTERN =
  /^\.deleted-([0-9a-f-]{36})-r([0-9]+)-c([0-9]+)-l([0-9]+)-t([0-9]+)$/i;

export type StudioDraftDeleteFaultStage =
  | "after_delete_rename"
  | "after_delete_directory_sync";

export type StudioDraftTombstone = {
  readonly draftId: string;
  readonly version: StudioDraftVersion;
  readonly path: string;
  readonly deletedAtMs: number;
};

function tombstoneName(
  draftId: string,
  version: StudioDraftVersion,
  deletedAtMs: number
): string {
  return `.deleted-${draftId}-r${version.recordRevision}-c${version.contentRevision}-l${version.layoutRevision}-t${deletedAtMs}`;
}

export function studioDraftTombstonePath(
  layout: StudioStorageLayout,
  draftId: string,
  version: StudioDraftVersion,
  deletedAtMs: number
): string {
  return path.join(
    layout.draftsRoot,
    tombstoneName(draftId, version, deletedAtMs)
  );
}

export function parseStudioDraftTombstoneName(
  name: string
): Omit<StudioDraftTombstone, "path"> | undefined {
  const match = TOMBSTONE_PATTERN.exec(name);
  if (match === null) {
    return undefined;
  }
  let draftId: string;
  try {
    draftId = parseStudioDraftId(match[1]!);
  } catch {
    return undefined;
  }
  const recordRevision = Number(match[2]);
  const contentRevision = Number(match[3]);
  const layoutRevision = Number(match[4]);
  const deletedAtMs = Number(match[5]);
  if (
    !Number.isSafeInteger(recordRevision) ||
    !Number.isSafeInteger(contentRevision) ||
    !Number.isSafeInteger(layoutRevision) ||
    recordRevision < 1 ||
    contentRevision < 1 ||
    layoutRevision < 0 ||
    !Number.isSafeInteger(deletedAtMs) ||
    deletedAtMs < 0
  ) {
    return undefined;
  }
  return {
    draftId,
    version: { recordRevision, contentRevision, layoutRevision },
    deletedAtMs
  };
}

export async function listStudioDraftTombstones(
  layout: StudioStorageLayout,
  maxEntries: number
): Promise<readonly StudioDraftTombstone[]> {
  const entries = await readBoundedPrivateDirectoryEntries(
    layout.draftsRoot,
    maxEntries,
    "Studio drafts directory"
  );

  const tombstones: StudioDraftTombstone[] = [];
  for (const entry of entries) {
    const parsed = parseStudioDraftTombstoneName(entry.name);
    if (parsed === undefined) {
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new StudioDraftPersistenceError(
        "studio_storage_invalid",
        "A Studio deletion tombstone is not a real directory"
      );
    }
    const entryPath = path.join(layout.draftsRoot, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new StudioDraftPersistenceError(
        "studio_storage_invalid",
        "A Studio deletion tombstone changed while being inspected"
      );
    }
    tombstones.push({
      ...parsed,
      path: entryPath
    });
  }
  return tombstones;
}

export async function findStudioDraftTombstone(
  layout: StudioStorageLayout,
  draftId: string,
  maxEntries: number
): Promise<StudioDraftTombstone | undefined> {
  const matches = (await listStudioDraftTombstones(layout, maxEntries)).filter(
    (tombstone) => tombstone.draftId === draftId
  );
  if (matches.length > 1) {
    throw new StudioDraftPersistenceError(
      "studio_storage_invalid",
      `Studio draft ${draftId} has multiple deletion tombstones`,
      { details: { draftId } }
    );
  }
  return matches[0];
}

export async function commitStudioDraftDelete(input: {
  readonly layout: StudioStorageLayout;
  readonly draftId: string;
  readonly version: StudioDraftVersion;
  readonly deletedAtMs: number;
  readonly faultInjector?: (
    stage: StudioDraftDeleteFaultStage
  ) => Promise<void> | void;
}): Promise<void> {
  const source = studioDraftDirectory(input.layout, input.draftId);
  const tombstone = studioDraftTombstonePath(
    input.layout,
    input.draftId,
    input.version,
    input.deletedAtMs
  );
  let renamed = false;
  try {
    await rename(source, tombstone);
    renamed = true;
    await input.faultInjector?.("after_delete_rename");
    await syncPrivateDirectory(
      input.layout.draftsRoot,
      "Studio drafts directory after delete"
    );
    await input.faultInjector?.("after_delete_directory_sync");
  } catch (cause) {
    throw new StudioDraftPersistenceError(
      renamed
        ? "studio_storage_commit_ambiguous"
        : "studio_storage_io_failed",
      renamed
        ? `Studio draft ${input.draftId} deletion may have committed`
        : `Unable to delete Studio draft ${input.draftId}`,
      { cause, details: { draftId: input.draftId } }
    );
  }
}

export async function confirmStudioDraftDelete(
  layout: StudioStorageLayout,
  draftId: string
): Promise<void> {
  try {
    await syncPrivateDirectory(
      layout.draftsRoot,
      "Studio drafts directory while confirming delete"
    );
  } catch (cause) {
    throw new StudioDraftPersistenceError(
      "studio_storage_commit_ambiguous",
      `Studio draft ${draftId} deletion could not be confirmed durable`,
      { cause, details: { draftId } }
    );
  }
}
