export const ARTIFACT_READER_ERROR_CODES = [
  "artifact_backend_unsupported",
  "artifact_catalog_corrupt",
  "artifact_content_changed",
  "artifact_handle_invalid",
  "artifact_input_invalid",
  "artifact_io_failed",
  "artifact_not_found",
  "artifact_security_violation",
  "artifact_too_large",
  "artifact_unavailable"
] as const;

export type ArtifactReaderErrorCode =
  (typeof ARTIFACT_READER_ERROR_CODES)[number];

export class ArtifactReaderError extends Error {
  readonly code: ArtifactReaderErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: ArtifactReaderErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean | null>> = {}
  ) {
    super(message);
    this.name = "ArtifactReaderError";
    this.code = code;
    this.details = details;
  }
}
export function artifactReaderError(
  code: ArtifactReaderErrorCode,
  message: string,
  details: Readonly<Record<string, string | number | boolean | null>> = {}
): ArtifactReaderError {
  return new ArtifactReaderError(code, message, details);
}
