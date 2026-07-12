import { z } from "zod";

export const ARTIFACT_SEMANTIC_TYPE_MAX_LENGTH = 128;

/**
 * Stable, namespaced artifact meaning with an explicit positive schema version.
 * Examples: `luna.review.findings.v1`, `vendor.domain.result.v2`.
 */
export const ARTIFACT_SEMANTIC_TYPE_PATTERN =
  /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\.v[1-9][0-9]{0,5}$/;

export const ArtifactSemanticTypeSchema = z
  .string()
  .min(1)
  .max(ARTIFACT_SEMANTIC_TYPE_MAX_LENGTH)
  .regex(
    ARTIFACT_SEMANTIC_TYPE_PATTERN,
    "Artifact semantic type must be namespaced and end in a positive .vN version"
  );

export type ArtifactSemanticType = z.infer<typeof ArtifactSemanticTypeSchema>;
