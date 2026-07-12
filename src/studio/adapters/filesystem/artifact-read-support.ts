import { createHash } from "node:crypto";
import type { ArtifactManifest } from "../../../core/runtime/artifacts/contracts.js";
import {
  ArtifactMetadataSchema,
  type ArtifactMetadata,
  type ArtifactSummary
} from "../../contracts/artifacts.js";
import {
  ArtifactReaderError,
  artifactReaderError
} from "../../application/artifacts/errors.js";
import { SecureReadFileError } from "./secure-read-file.js";
import type { SecureReadonlyFile } from "./secure-read-file.js";

export function positiveArtifactReaderLimit(
  value: number,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

export function artifactMetadataFor(
  summary: ArtifactSummary,
  contentLength: number
): ArtifactMetadata {
  return ArtifactMetadataSchema.parse({
    ...summary,
    content_length: contentLength,
    downloadable: true,
    raw_download_redaction: "not_applied"
  });
}

export async function readArtifactPreviewBytes(
  file: SecureReadonlyFile,
  maximum: number
): Promise<Buffer> {
  const length = Math.min(file.size, maximum);
  const content = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await file.handle.read(content, offset, length - offset, offset);
    if (read.bytesRead === 0) {
      throw artifactReaderError(
        "artifact_content_changed",
        "Artifact content changed while it was being read"
      );
    }
    offset += read.bytesRead;
  }
  return content;
}

export function artifactPreviewIntegrity(
  manifest: ArtifactManifest,
  content: Uint8Array,
  truncated: boolean
): "verified" | "not_checked" | "not_declared" {
  if (manifest.content_hash === undefined) {
    return "not_declared";
  }
  if (truncated) {
    return "not_checked";
  }
  const actual = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (actual !== manifest.content_hash) {
    throw artifactReaderError(
      "artifact_content_changed",
      "Artifact content does not match its manifest"
    );
  }
  return "verified";
}

export function mapUnexpectedArtifactReadError(
  cause: unknown
): ArtifactReaderError {
  if (cause instanceof ArtifactReaderError) {
    return cause;
  }
  if (cause instanceof SecureReadFileError) {
    switch (cause.code) {
      case "missing":
      case "not_regular_file":
        return artifactReaderError(
          "artifact_not_found",
          "Artifact content is unavailable"
        );
      case "security_violation":
        return artifactReaderError(
          "artifact_security_violation",
          "Artifact content failed path security checks"
        );
      case "size_unsupported":
        return artifactReaderError(
          "artifact_too_large",
          "Artifact size is unsupported"
        );
      case "io_failed":
        return artifactReaderError(
          "artifact_io_failed",
          "Artifact content could not be read"
        );
    }
  }
  return artifactReaderError(
    "artifact_io_failed",
    "Artifact content could not be read"
  );
}
