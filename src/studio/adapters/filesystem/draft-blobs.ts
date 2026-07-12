import {
  StudioDraftPersistenceError,
  type StudioDraftBlob
} from "../../application/drafts/persistence.js";
import type { StudioChangeSet } from "../../contracts/drafts.js";
import {
  digestStudioBlob,
  encodeStudioBlob,
  parseStudioBlobDigest,
  referencedStudioBlobDigests
} from "./draft-codec.js";
import {
  assertStudioPrivateFileSize,
  type StudioPrivateFileLimit
} from "./storage-limits.js";

export type PreparedStudioDraftBlob = {
  readonly digest: string;
  readonly bytes: Buffer;
};

export function prepareStudioDraftBlobs(
  changeSet: StudioChangeSet,
  blobs: readonly StudioDraftBlob[],
  limit: StudioPrivateFileLimit,
  maxBatchBytes: number
): readonly PreparedStudioDraftBlob[] {
  const referenced = new Set(referencedStudioBlobDigests(changeSet));
  const seen = new Set<string>();
  let batchBytes = 0;
  return blobs.map((blob) => {
    const digest = parseStudioBlobDigest(blob.digest);
    if (seen.has(digest)) {
      throw new StudioDraftPersistenceError(
        "studio_blob_duplicate",
        `Studio blob ${digest} was supplied more than once`,
        { details: { digest, draftId: changeSet.draft_id } }
      );
    }
    seen.add(digest);
    if (!referenced.has(digest)) {
      throw new StudioDraftPersistenceError(
        "studio_blob_unreferenced",
        `Studio blob ${digest} is not referenced by the draft`,
        { details: { digest, draftId: changeSet.draft_id } }
      );
    }
    const bytes = encodeStudioBlob(blob.content);
    assertStudioPrivateFileSize(bytes.byteLength, limit);
    batchBytes += bytes.byteLength;
    if (batchBytes > maxBatchBytes) {
      throw new StudioDraftPersistenceError(
        "studio_storage_quota_exceeded",
        `Studio blob batch exceeds the ${maxBatchBytes}-byte aggregate quota`,
        { details: { actualBytes: batchBytes, maxBytes: maxBatchBytes } }
      );
    }
    if (digestStudioBlob(bytes) !== digest) {
      throw new StudioDraftPersistenceError(
        "studio_blob_digest_mismatch",
        `Studio blob ${digest} does not match its supplied content`,
        { details: { digest, draftId: changeSet.draft_id } }
      );
    }
    return { digest, bytes };
  });
}
