import type {
  ArtifactList,
  ArtifactManifestHandle,
  ArtifactMetadata,
  ArtifactPreview,
  ArtifactPreviewRequest,
  ArtifactSummary
} from "../../contracts/artifacts.js";
import type { RuntimeArtifactRef } from "../../../core/runtime/state.js";

export type ArtifactReferenceResolution = {
  readonly matches: readonly (
    | { readonly status: "resolved"; readonly artifact: ArtifactSummary }
    | { readonly status: "unresolved" }
  )[];
};

export type ArtifactDownload = {
  readonly metadata: ArtifactMetadata;
  /**
   * The original artifact bytes. They are intentionally streamed and are not
   * redacted. Callers must force attachment download rather than inline render.
   */
  readonly body: AsyncIterable<Uint8Array>;
  readonly disposition: "attachment";
  readonly redaction: "not_applied";
};

export interface ArtifactReaderPort {
  list(runId: string): Promise<ArtifactList>;
  resolveReferences(
    runId: string,
    references: readonly RuntimeArtifactRef[]
  ): Promise<ArtifactReferenceResolution>;
  metadata(runId: string, handle: ArtifactManifestHandle): Promise<ArtifactMetadata>;
  preview(request: ArtifactPreviewRequest): Promise<ArtifactPreview>;
  openDownload(
    runId: string,
    handle: ArtifactManifestHandle
  ): Promise<ArtifactDownload>;
}
