import { createHash } from "node:crypto";
import { z } from "zod";
import { parseAndAssertStudioChangeSet } from "../../application/drafts/change-set.js";
import { StudioDraftPersistenceError } from "../../application/drafts/persistence.js";
import { StudioDigestSchema } from "../../contracts/digests.js";
import {
  StudioDraftSummarySchema,
  type StudioChangeSet,
  type StudioDraftSummary
} from "../../contracts/drafts.js";

const StudioDraftIdSchema = z.string().uuid();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function draftValidationError(
  code: "studio_draft_invalid" | "studio_draft_corrupt",
  message: string,
  draftId: string | undefined,
  cause?: unknown
): StudioDraftPersistenceError {
  return new StudioDraftPersistenceError(code, message, {
    cause,
    details: draftId === undefined ? {} : { draftId }
  });
}

function decodeDraftBytes(bytes: Uint8Array, draftId: string): unknown {
  let content: string;
  try {
    content = UTF8_DECODER.decode(bytes);
  } catch (cause) {
    throw draftValidationError(
      "studio_draft_corrupt",
      `Studio draft ${draftId} is not valid UTF-8`,
      draftId,
      cause
    );
  }

  try {
    return JSON.parse(content) as unknown;
  } catch (cause) {
    throw draftValidationError(
      "studio_draft_corrupt",
      `Studio draft ${draftId} is not valid JSON`,
      draftId,
      cause
    );
  }
}

function validateChangeSet(
  value: unknown,
  code: "studio_draft_invalid" | "studio_draft_corrupt",
  draftId?: string
): StudioChangeSet {
  let parsed: StudioChangeSet;
  try {
    parsed = parseAndAssertStudioChangeSet(value);
  } catch (cause) {
    throw draftValidationError(
      code,
      draftId === undefined
        ? "Studio draft does not satisfy the change-set contract"
        : `Studio draft ${draftId} does not satisfy the change-set contract`,
      draftId,
      cause
    );
  }
  return parsed;
}

export function parseStudioDraftId(value: string): string {
  const parsed = StudioDraftIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new StudioDraftPersistenceError(
      "studio_draft_id_invalid",
      "Studio draft id must be a UUID",
      { cause: parsed.error, details: { draftId: value } }
    );
  }
  return parsed.data;
}

export function parseStudioBlobDigest(value: string): string {
  const parsed = StudioDigestSchema.safeParse(value);
  if (!parsed.success) {
    throw new StudioDraftPersistenceError(
      "studio_blob_digest_invalid",
      "Studio blob digest must be a lowercase SHA-256 reference",
      { cause: parsed.error, details: { digest: value } }
    );
  }
  return parsed.data;
}

export function digestStudioBlob(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function encodeStudioBlob(content: string): Buffer {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.toString("utf8") !== content) {
    throw new StudioDraftPersistenceError(
      "studio_blob_content_invalid",
      "Studio blobs must be losslessly encodable as UTF-8"
    );
  }
  return bytes;
}

export function decodeStudioBlob(bytes: Uint8Array, digest: string): string {
  const actualDigest = digestStudioBlob(bytes);
  if (actualDigest !== digest) {
    throw new StudioDraftPersistenceError(
      "studio_blob_corrupt",
      `Studio blob ${digest} does not match its content address`,
      { details: { digest } }
    );
  }

  try {
    return UTF8_DECODER.decode(bytes);
  } catch (cause) {
    throw new StudioDraftPersistenceError(
      "studio_blob_corrupt",
      `Studio blob ${digest} is not valid UTF-8`,
      { cause, details: { digest } }
    );
  }
}

export function normalizeStudioDraftInput(value: unknown): StudioChangeSet {
  return validateChangeSet(value, "studio_draft_invalid");
}

export function decodeStoredStudioDraft(
  bytes: Uint8Array,
  expectedDraftId: string
): StudioChangeSet {
  const parsed = validateChangeSet(
    decodeDraftBytes(bytes, expectedDraftId),
    "studio_draft_corrupt",
    expectedDraftId
  );
  if (parsed.draft_id !== expectedDraftId) {
    throw draftValidationError(
      "studio_draft_corrupt",
      `Studio draft filename does not match embedded id ${parsed.draft_id}`,
      expectedDraftId
    );
  }
  return parsed;
}

export function encodeStudioDraft(changeSet: StudioChangeSet): string {
  return `${JSON.stringify(changeSet, null, 2)}\n`;
}

export function toStudioDraftSummary(
  changeSet: StudioChangeSet
): StudioDraftSummary {
  return StudioDraftSummarySchema.parse({
    draft_id: changeSet.draft_id,
    record_revision: changeSet.record_revision,
    content_revision: changeSet.content_revision,
    layout_revision: changeSet.layout_revision,
    primary_resource: changeSet.primary_resource,
    draft_hash: changeSet.draft_hash,
    status: changeSet.status,
    updated_at: changeSet.updated_at
  });
}

export function referencedStudioBlobDigests(
  changeSet: StudioChangeSet
): readonly string[] {
  const references = new Set<string>();
  for (const baseFile of changeSet.base_files) {
    if (baseFile.content_ref === null) {
      continue;
    }
    references.add(baseFile.content_ref);
  }
  for (const change of changeSet.changes) {
    if (change.action === "write") {
      references.add(change.content_ref);
    }
  }
  return [...references].sort((left, right) => left.localeCompare(right));
}
