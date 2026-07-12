import type { ArtifactManifest } from "../../../core/runtime/artifacts/contracts.js";
import { isReservedFilesystemArtifactPath } from "../../../core/runtime/artifacts/filesystem-paths.js";
import { assertSafeArtifactPath } from "../../../core/runtime/artifacts/transaction.js";
import {
  ArtifactSummarySchema,
  type ArtifactSummary
} from "../../contracts/artifacts.js";
import { artifactReaderError } from "../../application/artifacts/errors.js";
import type { ArtifactHandleCodec } from "./artifact-handles.js";
import {
  artifactExposureStatus,
  isActiveArtifactContent,
  isReadableArtifactStatus,
  normalizedArtifactMediaType,
  safeArtifactDisplayName
} from "./artifact-presentation.js";

function validateContentHash(manifest: ArtifactManifest): void {
  if (
    manifest.content_hash !== undefined &&
    !/^sha256:[a-f0-9]{64}$/.test(manifest.content_hash)
  ) {
    throw artifactReaderError(
      "artifact_catalog_corrupt",
      "Artifact metadata is invalid"
    );
  }
}

export function validateArtifactManifest(
  manifest: ArtifactManifest,
  runId: string,
  backendId: string
): string {
  if (
    manifest.id.length < 1 ||
    manifest.id.length > 4_096 ||
    (manifest.source_node_id !== undefined &&
      (manifest.source_node_id.length < 1 || manifest.source_node_id.length > 256)) ||
    (manifest.backend_root !== undefined && manifest.backend_root.length > 8_192) ||
    !Number.isSafeInteger(manifest.attempt ?? 1) ||
    (manifest.attempt ?? 1) < 1
  ) {
    throw artifactReaderError("artifact_catalog_corrupt", "Artifact metadata is invalid");
  }
  if (
    manifest.run_id !== runId ||
    (manifest.backend_id !== undefined && manifest.backend_id !== backendId)
  ) {
    throw artifactReaderError(
      manifest.run_id === runId
        ? "artifact_backend_unsupported"
        : "artifact_catalog_corrupt",
      manifest.run_id === runId
        ? "Artifact backend is not available through this reader"
        : "Artifact metadata is invalid"
    );
  }
  if (manifest.artifact_path === undefined || manifest.artifact_path.length > 4_096) {
    throw artifactReaderError("artifact_catalog_corrupt", "Artifact metadata is invalid");
  }
  const segments = manifest.artifact_path.split("/");
  if (segments.length > 128 || segments.some((segment) => segment.length > 255)) {
    throw artifactReaderError("artifact_catalog_corrupt", "Artifact metadata is invalid");
  }
  if (isReservedFilesystemArtifactPath(manifest.artifact_path)) {
    throw artifactReaderError(
      "artifact_security_violation",
      "Artifact path uses a reserved storage location"
    );
  }
  try {
    assertSafeArtifactPath(manifest.artifact_path);
  } catch {
    throw artifactReaderError("artifact_security_violation", "Artifact path is not allowed");
  }
  validateContentHash(manifest);
  return manifest.artifact_path;
}

export function projectArtifactSummary(
  manifest: ArtifactManifest,
  runId: string,
  backendId: string,
  handles: ArtifactHandleCodec
): ArtifactSummary {
  const artifactPath = validateArtifactManifest(manifest, runId, backendId);
  const mediaType = normalizedArtifactMediaType(manifest, artifactPath);
  const status = artifactExposureStatus(manifest);
  const parsed = ArtifactSummarySchema.safeParse({
    manifest_handle: handles.encode(manifest),
    name: safeArtifactDisplayName(artifactPath),
    ...(manifest.source_node_id === undefined
      ? {}
      : { source_node_id: manifest.source_node_id }),
    attempt: manifest.attempt ?? 1,
    media_type: mediaType,
    ...(manifest.semantic_type === undefined
      ? {}
      : { semantic_type: manifest.semantic_type }),
    ...(manifest.content_hash === undefined
      ? {}
      : { content_hash: manifest.content_hash }),
    status,
    created_at: manifest.created_at,
    preview_capability: !isReadableArtifactStatus(status)
      ? "unavailable"
      : isActiveArtifactContent(mediaType)
        ? "download_only"
        : "probe_required"
  });
  if (!parsed.success) {
    throw artifactReaderError("artifact_catalog_corrupt", "Artifact metadata is invalid");
  }
  return parsed.data;
}
