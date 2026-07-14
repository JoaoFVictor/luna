export class ArtifactContentReadLimitError extends Error {
  readonly code = "artifact_content_read_limit_exceeded" as const;

  constructor() {
    super("Artifact content exceeds its bounded read contract");
    this.name = "ArtifactContentReadLimitError";
  }
}

export function artifactContentReadLimitError(): ArtifactContentReadLimitError {
  return new ArtifactContentReadLimitError();
}

export function isArtifactContentReadLimitError(
  cause: unknown
): cause is ArtifactContentReadLimitError {
  return cause instanceof ArtifactContentReadLimitError;
}
