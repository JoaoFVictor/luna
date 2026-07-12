import { StudioDraftPersistenceError } from "../../application/drafts/persistence.js";
import type { StudioDraftListDiagnostic } from "../../contracts/drafts.js";
import {
  parseStudioDraftId,
  toStudioDraftSummary
} from "./draft-codec.js";
import type { StudioDraftListEntry } from "./draft-list.js";
import { readStudioDraftMetadata } from "./draft-record-store.js";
import type { StudioStorageLayout } from "./private-storage.js";
import type { StudioPrivateFileLimit } from "./storage-limits.js";

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

export async function readStudioDraftListEntry(
  layout: StudioStorageLayout,
  limit: StudioPrivateFileLimit,
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
    const changeSet = await readStudioDraftMetadata(layout, limit, draftId);
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
