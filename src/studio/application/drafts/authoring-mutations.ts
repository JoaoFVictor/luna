import { canonicalJson } from "../../../core/workflow/definition-digests.js";
import {
  STUDIO_DRAFT_AUTHORING_LIMITS,
  type StudioDraftContentEdit,
  type StudioDraftPatchRequest
} from "../../contracts/draft-authoring.js";
import type {
  StudioChangeSet,
  StudioDraftFileChange
} from "../../contracts/drafts.js";
import {
  studioPathKey,
  type StudioPath
} from "../../contracts/paths.js";
import {
  computeStudioDraftHash,
  parseAndAssertStudioChangeSet
} from "./change-set.js";
import type { StudioDraftBlob } from "./persistence.js";
import { StudioDraftAuthoringError } from "./authoring-errors.js";
import { studioAuthoringContentDigest } from "./authoring-digests.js";
import {
  isStudioEditableResource,
  isStudioEditableResourcePath
} from "./authoring-resource-paths.js";

export type StudioDraftPatchMutation = {
  readonly changeSet: StudioChangeSet;
  readonly blobs: readonly StudioDraftBlob[];
};

function assertEditableFile(
  changeSet: StudioChangeSet,
  allowed: ReadonlySet<string>,
  file: StudioPath
): void {
  if (
    !isStudioEditableResource(changeSet.primary_resource) ||
    !isStudioEditableResourcePath(changeSet.primary_resource, file) ||
    !allowed.has(studioPathKey(file))
  ) {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_file_not_editable",
      "The requested file is not editable in this Studio draft",
      { details: { draftId: changeSet.draft_id, file } }
    );
  }
}

function contentChange(
  edit: StudioDraftContentEdit,
  baseSha256: string | null,
  baseMode: number | null,
  current: StudioDraftFileChange | undefined
): { readonly change?: StudioDraftFileChange; readonly blob?: StudioDraftBlob } {
  if (edit.action === "delete") {
    return baseSha256 === null
      ? {}
      : {
          change: {
            action: "delete",
            file: edit.file,
            base_sha256: baseSha256
          }
        };
  }
  const bytes = Buffer.from(edit.content, "utf8");
  if (bytes.byteLength > STUDIO_DRAFT_AUTHORING_LIMITS.maxContentBytes) {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_patch_too_large",
      "A Studio draft edit exceeds its content limit",
      {
        details: {
          file: edit.file,
          actualBytes: bytes.byteLength,
          maxBytes: STUDIO_DRAFT_AUTHORING_LIMITS.maxContentBytes
        }
      }
    );
  }
  const digest = studioAuthoringContentDigest(bytes);
  if (digest === baseSha256) {
    return {};
  }
  const change: StudioDraftFileChange = {
    action: "write",
    file: edit.file,
    base_sha256: baseSha256,
    content_sha256: digest,
    content_ref: digest,
    ...(current?.action === "write" && current.eol !== undefined
      ? { eol: current.eol }
      : {}),
    mode:
      current?.action === "write" && current.mode !== undefined
        ? current.mode
        : (baseMode ?? 0o644)
  };
  return {
    change,
    ...(current?.action === "write" && current.content_ref === digest
      ? {}
      : { blob: { digest, content: edit.content } })
  };
}

function nextChanges(
  changeSet: StudioChangeSet,
  edits: readonly StudioDraftContentEdit[] | undefined
): {
  readonly changes: readonly StudioDraftFileChange[];
  readonly blobs: readonly StudioDraftBlob[];
} {
  if (edits === undefined) {
    return { changes: changeSet.changes, blobs: [] };
  }
  const allowed = new Set(changeSet.allowed_files.map(studioPathKey));
  const bases = new Map(
    changeSet.base_files.map((base) => [studioPathKey(base.file), base])
  );
  const changes = new Map(
    changeSet.changes.map((change) => [studioPathKey(change.file), change])
  );
  const seen = new Set<string>();
  const blobs = new Map<string, StudioDraftBlob>();
  let patchBytes = 0;
  for (const edit of edits) {
    const key = studioPathKey(edit.file);
    if (seen.has(key)) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_duplicate_edit",
        "A Studio draft patch cannot edit the same file twice",
        { details: { draftId: changeSet.draft_id, file: edit.file } }
      );
    }
    seen.add(key);
    assertEditableFile(changeSet, allowed, edit.file);
    const base = bases.get(key);
    if (base === undefined) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_file_not_editable",
        "The requested file has no server-authorized draft base",
        { details: { draftId: changeSet.draft_id, file: edit.file } }
      );
    }
    if (edit.action === "write") {
      patchBytes += Buffer.byteLength(edit.content, "utf8");
      if (patchBytes > STUDIO_DRAFT_AUTHORING_LIMITS.maxPatchBytes) {
        throw new StudioDraftAuthoringError(
          "studio_draft_authoring_patch_too_large",
          "The Studio draft patch exceeds its aggregate content limit",
          {
            details: {
              draftId: changeSet.draft_id,
              file: edit.file,
              actualBytes: patchBytes,
              maxBytes: STUDIO_DRAFT_AUTHORING_LIMITS.maxPatchBytes
            }
          }
        );
      }
    }
    const replacement = contentChange(
      edit,
      base.sha256,
      base.mode,
      changes.get(key)
    );
    if (replacement.change === undefined) {
      changes.delete(key);
    } else {
      changes.set(key, replacement.change);
    }
    if (replacement.blob !== undefined) {
      blobs.set(replacement.blob.digest, replacement.blob);
    }
  }
  return {
    changes: [...changes.values()].sort((left, right) =>
      studioPathKey(left.file).localeCompare(studioPathKey(right.file))
    ),
    blobs: [...blobs.values()]
  };
}

function assertLayoutLimit(layout: StudioDraftPatchRequest["layout"]): void {
  if (layout === undefined) {
    return;
  }
  const bytes = Buffer.byteLength(JSON.stringify(layout), "utf8");
  if (bytes > STUDIO_DRAFT_AUTHORING_LIMITS.maxLayoutBytes) {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_layout_too_large",
      "The Studio draft layout exceeds its content limit",
      {
        details: {
          actualBytes: bytes,
          maxBytes: STUDIO_DRAFT_AUTHORING_LIMITS.maxLayoutBytes
        }
      }
    );
  }
}

export function applyStudioDraftPatch(
  current: StudioChangeSet,
  patch: StudioDraftPatchRequest,
  now: string,
  options: { readonly comparisonDraftHash?: string } = {}
): StudioDraftPatchMutation {
  assertLayoutLimit(patch.layout);
  const content = nextChanges(current, patch.edits);
  const layoutChanged =
    patch.layout !== undefined &&
    canonicalJson(patch.layout) !== canonicalJson(current.layout ?? null);
  const contentCandidate: StudioChangeSet = {
    ...current,
    changes: [...content.changes]
  };
  const draftHash = computeStudioDraftHash(contentCandidate);
  const contentChanged =
    draftHash !== (options.comparisonDraftHash ?? current.draft_hash);
  if (!contentChanged && !layoutChanged) {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_noop",
      "The Studio draft patch does not change content or layout",
      { details: { draftId: current.draft_id } }
    );
  }
  const next = parseAndAssertStudioChangeSet({
    ...current,
    record_revision: current.record_revision + 1,
    content_revision:
      current.content_revision + (contentChanged ? 1 : 0),
    layout_revision: current.layout_revision + (layoutChanged ? 1 : 0),
    changes: [...content.changes],
    ...(layoutChanged ? { layout: patch.layout } : {}),
    status: contentChanged ? "dirty" : current.status,
    draft_hash: draftHash,
    updated_at: now
  });
  return { changeSet: next, blobs: content.blobs };
}
