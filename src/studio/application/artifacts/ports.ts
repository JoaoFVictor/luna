import type {
  ArtifactList,
  ArtifactManifestHandle,
  ArtifactMetadata,
  ArtifactPreview,
  ArtifactPreviewRequest
} from "../../contracts/artifacts.js";

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
  metadata(runId: string, handle: ArtifactManifestHandle): Promise<ArtifactMetadata>;
  preview(request: ArtifactPreviewRequest): Promise<ArtifactPreview>;
  openDownload(
    runId: string,
    handle: ArtifactManifestHandle
  ): Promise<ArtifactDownload>;
}
