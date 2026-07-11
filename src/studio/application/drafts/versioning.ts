import { canonicalJson } from "../../../core/workflow/definition-digests.js";
import type { StudioChangeSet } from "../../contracts/drafts.js";
import {
  StudioDraftPersistenceError,
  type StudioDraftVersion
} from "./persistence.js";

export function studioDraftVersion(
  changeSet: StudioChangeSet
): StudioDraftVersion {
  return {
    recordRevision: changeSet.record_revision,
    contentRevision: changeSet.content_revision,
    layoutRevision: changeSet.layout_revision
  };
}

export function assertStudioExpectedVersion(
  expected: StudioDraftVersion,
  draftId: string
): void {
  if (
    !Number.isSafeInteger(expected.recordRevision) ||
    expected.recordRevision < 1 ||
    !Number.isSafeInteger(expected.contentRevision) ||
    expected.contentRevision < 1 ||
    !Number.isSafeInteger(expected.layoutRevision) ||
    expected.layoutRevision < 0
  ) {
    throw new StudioDraftPersistenceError(
      "studio_draft_invalid",
      "Expected Studio record/content revisions must be positive and layout revision non-negative safe integers",
      { details: { draftId, expectedVersion: expected } }
    );
  }
}

export function assertStudioDraftVersionMatches(
  changeSet: StudioChangeSet,
  expected: StudioDraftVersion
): void {
  const actual = studioDraftVersion(changeSet);
  if (
    actual.recordRevision !== expected.recordRevision ||
    actual.contentRevision !== expected.contentRevision ||
    actual.layoutRevision !== expected.layoutRevision
  ) {
    throw new StudioDraftPersistenceError(
      "studio_draft_revision_conflict",
      `Studio draft ${changeSet.draft_id} was updated by another writer`,
      {
        details: {
          draftId: changeSet.draft_id,
          expectedVersion: expected,
          actualVersion: actual
        }
      }
    );
  }
}

export function assertStudioDraftCreateVersion(
  changeSet: StudioChangeSet
): void {
  if (
    changeSet.record_revision !== 1 ||
    changeSet.content_revision !== 1 ||
    changeSet.layout_revision !== 0
  ) {
    throw new StudioDraftPersistenceError(
      "studio_draft_invalid",
      "A new Studio draft must start at record/content revision 1 and layout revision 0",
      { details: { draftId: changeSet.draft_id } }
    );
  }
}

function invalidUpdate(message: string, draftId: string): never {
  throw new StudioDraftPersistenceError("studio_draft_invalid", message, {
    details: { draftId }
  });
}

export function assertStudioDraftUpdate(
  current: StudioChangeSet,
  candidate: StudioChangeSet
): void {
  if (candidate.draft_id !== current.draft_id) {
    invalidUpdate("A Studio draft update cannot change its id", current.draft_id);
  }
  if (candidate.created_at !== current.created_at) {
    invalidUpdate(
      "A Studio draft update cannot change its creation timestamp",
      current.draft_id
    );
  }

  const recordDelta = candidate.record_revision - current.record_revision;
  const contentDelta =
    candidate.content_revision - current.content_revision;
  const layoutDelta = candidate.layout_revision - current.layout_revision;
  if (recordDelta !== 1) {
    invalidUpdate(
      "A Studio draft update must advance record revision exactly once",
      current.draft_id
    );
  }
  const contentChanged = candidate.draft_hash !== current.draft_hash;
  if (contentDelta !== (contentChanged ? 1 : 0)) {
    invalidUpdate(
      contentChanged
        ? "Studio draft content changed without advancing content revision"
        : "Studio content revision advanced without a content change",
      current.draft_id
    );
  }
  const layoutChanged =
    canonicalJson(candidate.layout ?? null) !==
    canonicalJson(current.layout ?? null);
  if (layoutDelta !== (layoutChanged ? 1 : 0)) {
    invalidUpdate(
      layoutChanged
        ? "Studio draft layout changed without advancing layout revision"
        : "Studio layout revision advanced without a layout change",
      current.draft_id
    );
  }
  const recordSemanticsChanged =
    contentChanged ||
    layoutChanged ||
    candidate.status !== current.status ||
    candidate.presentation_catalog_fingerprint !==
      current.presentation_catalog_fingerprint;
  if (!recordSemanticsChanged) {
    invalidUpdate(
      "A Studio draft update must change persisted semantics",
      current.draft_id
    );
  }
  if (Date.parse(candidate.updated_at) < Date.parse(current.updated_at)) {
    invalidUpdate(
      "A Studio draft update timestamp cannot move backwards",
      current.draft_id
    );
  }
}
