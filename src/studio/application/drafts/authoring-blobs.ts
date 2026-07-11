import type { StudioDraftBlob } from "./persistence.js";
import { StudioDraftAuthoringError } from "./authoring-errors.js";

export function mergeStudioDraftBlobs(
  ...collections: readonly (readonly StudioDraftBlob[])[]
): readonly StudioDraftBlob[] {
  const merged = new Map<string, StudioDraftBlob>();
  for (const collection of collections) {
    for (const blob of collection) {
      const current = merged.get(blob.digest);
      if (current !== undefined && current.content !== blob.content) {
        throw new StudioDraftAuthoringError(
          "studio_draft_authoring_source_invalid",
          "Studio draft blobs with the same digest contain different bytes"
        );
      }
      merged.set(blob.digest, current ?? blob);
    }
  }
  return [...merged.values()];
}
