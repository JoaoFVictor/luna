import path from "node:path";
import {
  STUDIO_DRAFT_AUTHORING_LIMITS,
  StudioDraftAuthoringListPageSchema,
  StudioDraftItemSchema,
  type StudioDraftAuthoringListPage,
  type StudioDraftFile,
  type StudioDraftItem
} from "../../contracts/draft-authoring.js";
import type { StudioChangeSet } from "../../contracts/drafts.js";
import {
  studioPathKey,
  type StudioPath
} from "../../contracts/paths.js";
import type {
  StudioDraftListInput,
  StudioDraftPersistencePort
} from "./persistence.js";
import { StudioDraftAuthoringError } from "./authoring-errors.js";
import { studioDraftEtag } from "./versioning.js";

const MAX_PROJECTED_FILE_BYTES =
  STUDIO_DRAFT_AUTHORING_LIMITS.maxContentBytes;
const MAX_PROJECTED_TOTAL_BYTES =
  STUDIO_DRAFT_AUTHORING_LIMITS.maxProjectionBytes;

function mediaType(file: StudioPath): StudioDraftFile["media_type"] {
  switch (path.posix.extname(file.path).toLowerCase()) {
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".md":
      return "text/markdown";
    default:
      return "text/plain";
  }
}

async function projectFiles(
  drafts: StudioDraftPersistencePort,
  changeSet: StudioChangeSet
): Promise<readonly StudioDraftFile[]> {
  const changes = new Map(
    changeSet.changes.map((change) => [studioPathKey(change.file), change])
  );
  const baseFiles = new Map(
    changeSet.base_files.map((base) => [studioPathKey(base.file), base])
  );
  let totalBytes = 0;
  const projected: StudioDraftFile[] = [];
  for (const file of [...changeSet.allowed_files].sort((left, right) =>
    studioPathKey(left).localeCompare(studioPathKey(right))
  )) {
    const key = studioPathKey(file);
    const change = changes.get(key);
    const contentRef =
      change?.action === "write"
        ? change.content_ref
        : change?.action === "delete"
          ? null
          : (baseFiles.get(key)?.content_ref ?? null);
    if (contentRef === null) {
      projected.push({
        file,
        media_type: mediaType(file),
        state: "deleted"
      });
      continue;
    }
    let content: string;
    try {
      content = await drafts.getBlob(changeSet.draft_id, contentRef, {
        maxBytes: MAX_PROJECTED_FILE_BYTES
      });
    } catch (cause) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_source_invalid",
        "A Studio draft file could not be projected safely",
        { cause, details: { draftId: changeSet.draft_id, file } }
      );
    }
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > MAX_PROJECTED_TOTAL_BYTES) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_source_too_large",
        "The Studio draft exceeds its response projection limit",
        {
          details: {
            draftId: changeSet.draft_id,
            file,
            actualBytes: totalBytes,
            maxBytes: MAX_PROJECTED_TOTAL_BYTES
          }
        }
      );
    }
    projected.push({
      file,
      media_type: mediaType(file),
      state: "present",
      content
    });
  }
  return projected;
}

export async function projectStudioDraftItem(
  drafts: StudioDraftPersistencePort,
  changeSet: StudioChangeSet
): Promise<StudioDraftItem> {
  if (
    changeSet.primary_resource.kind !== "workflow" &&
    changeSet.primary_resource.kind !== "agent"
  ) {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_resource_invalid",
      "The Studio draft is not an editable workflow or agent",
      { details: { draftId: changeSet.draft_id } }
    );
  }
  return StudioDraftItemSchema.parse({
    draft_id: changeSet.draft_id,
    record_revision: changeSet.record_revision,
    content_revision: changeSet.content_revision,
    layout_revision: changeSet.layout_revision,
    primary_resource: changeSet.primary_resource,
    status: changeSet.status,
    draft_hash: changeSet.draft_hash,
    etag: studioDraftEtag(changeSet),
    files: await projectFiles(drafts, changeSet),
    ...(changeSet.layout === undefined ? {} : { layout: changeSet.layout }),
    created_at: changeSet.created_at,
    updated_at: changeSet.updated_at
  });
}

export async function projectStudioDraftList(
  drafts: StudioDraftPersistencePort,
  input: StudioDraftListInput
): Promise<StudioDraftAuthoringListPage> {
  const page = await drafts.list({
    ...input,
    primaryResourceKinds: ["workflow", "agent"]
  });
  if (
    page.items.some(
      (item) =>
        item.primary_resource.kind !== "workflow" &&
        item.primary_resource.kind !== "agent"
    )
  ) {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_config_invalid",
      "The Studio draft repository did not enforce the authoring list scope"
    );
  }
  return StudioDraftAuthoringListPageSchema.parse({
    items: page.items.map((item) => ({
      ...item,
      etag: studioDraftEtag(item)
    })),
    diagnostics: page.diagnostics,
    next_cursor: page.next_cursor
  });
}
