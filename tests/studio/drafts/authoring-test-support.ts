import type {
  StudioDraftCreate,
  StudioDraftDelete,
  StudioDraftListInput,
  StudioDraftPersistencePort,
  StudioDraftUpdate
} from "../../../src/studio/application/drafts/persistence.js";
import { StudioDraftPersistenceError } from "../../../src/studio/application/drafts/persistence.js";
import { studioAuthoringContentDigest } from "../../../src/studio/application/drafts/authoring-digests.js";
import type { StudioAuthoringSourcePort } from "../../../src/studio/application/drafts/authoring-ports.js";
import {
  StudioDraftListPageSchema,
  StudioDraftSummarySchema,
  type StudioChangeSet,
  type StudioDraftListPage
} from "../../../src/studio/contracts/drafts.js";
import { studioPathKey, type StudioPath } from "../../../src/studio/contracts/paths.js";

export const AUTHORING_DRAFT_ID = "5bbc0ae8-d9f1-4cc2-b704-8186c026ad38";
export const TECHNICAL_FINGERPRINT =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const PRESENTATION_FINGERPRINT =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const RESOURCE_REVISION =
  "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function versionMatches(
  draft: StudioChangeSet,
  expected: StudioDraftUpdate["expectedVersion"]
): boolean {
  return (
    draft.record_revision === expected.recordRevision &&
    draft.content_revision === expected.contentRevision &&
    draft.layout_revision === expected.layoutRevision
  );
}
export class MemoryAuthoringDrafts implements StudioDraftPersistencePort {
  draft: StudioChangeSet | undefined;
  readonly blobs = new Map<string, string>();

  async create(input: StudioDraftCreate): Promise<StudioChangeSet> {
    if (this.draft !== undefined) {
      throw new StudioDraftPersistenceError(
        "studio_draft_already_exists",
        "The Studio draft already exists",
        { details: { draftId: input.changeSet.draft_id } }
      );
    }
    this.storeBlobs(input.blobs);
    this.draft = input.changeSet;
    return input.changeSet;
  }

  async get(draftId: string): Promise<StudioChangeSet | undefined> {
    return this.draft?.draft_id === draftId ? this.draft : undefined;
  }

  async list(input: StudioDraftListInput = {}): Promise<StudioDraftListPage> {
    const included =
      this.draft !== undefined &&
      (input.primaryResourceKinds === undefined ||
        input.primaryResourceKinds.includes(
          this.draft.primary_resource.kind
        ));
    return StudioDraftListPageSchema.parse({
      items:
        !included || this.draft === undefined
          ? []
          : [
              StudioDraftSummarySchema.parse({
                draft_id: this.draft.draft_id,
                record_revision: this.draft.record_revision,
                content_revision: this.draft.content_revision,
                layout_revision: this.draft.layout_revision,
                primary_resource: this.draft.primary_resource,
                draft_hash: this.draft.draft_hash,
                status: this.draft.status,
                updated_at: this.draft.updated_at
              })
            ],
      diagnostics: [],
      next_cursor: null
    });
  }

  async update(input: StudioDraftUpdate): Promise<StudioChangeSet> {
    if (
      this.draft === undefined ||
      !versionMatches(this.draft, input.expectedVersion)
    ) {
      throw new StudioDraftPersistenceError(
        "studio_draft_revision_conflict",
        "The Studio draft changed concurrently",
        {
          details: {
            draftId: input.changeSet.draft_id,
            expectedVersion: input.expectedVersion
          }
        }
      );
    }
    this.storeBlobs(input.blobs);
    this.draft = input.changeSet;
    return input.changeSet;
  }

  async delete(input: StudioDraftDelete): Promise<void> {
    if (
      this.draft === undefined ||
      this.draft.draft_id !== input.draftId ||
      !versionMatches(this.draft, input.expectedVersion)
    ) {
      throw new StudioDraftPersistenceError(
        "studio_draft_revision_conflict",
        "The Studio draft changed concurrently",
        {
          details: {
            draftId: input.draftId,
            expectedVersion: input.expectedVersion
          }
        }
      );
    }
    this.draft = undefined;
  }

  async getBlob(
    draftId: string,
    digest: string,
    options: { readonly maxBytes: number }
  ): Promise<string> {
    if (this.draft?.draft_id !== draftId) {
      throw new Error("missing draft");
    }
    const content = this.blobs.get(digest);
    if (content === undefined) {
      throw new Error("missing blob");
    }
    if (Buffer.byteLength(content, "utf8") > options.maxBytes) {
      throw new Error("blob too large");
    }
    return content;
  }

  private storeBlobs(
    blobs: readonly { readonly digest: string; readonly content: string }[]
  ): void {
    for (const blob of blobs) {
      this.blobs.set(blob.digest, blob.content);
    }
  }
}

export function memoryAuthoringSource(
  files: Readonly<Record<string, string | { content: string; mode: number }>>
): StudioAuthoringSourcePort {
  const values = new Map(
    Object.entries(files).map(([key, value]) => [
      key,
      typeof value === "string" ? { content: value, mode: 0o644 } : value
    ])
  );
  return {
    async read(file: StudioPath, options: { readonly maxBytes: number }) {
      const value = values.get(studioPathKey(file));
      if (value === undefined) {
        return undefined;
      }
      const content = Buffer.from(value.content, "utf8");
      if (content.byteLength > options.maxBytes) {
        throw new Error("source too large");
      }
      return {
        content,
        sha256: studioAuthoringContentDigest(content),
        mode: value.mode
      };
    }
  };
}
