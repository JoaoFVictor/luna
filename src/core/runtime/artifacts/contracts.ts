import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactSemanticTypeSchema } from "../../artifacts/semantic-type.js";

export const ArtifactManifestSchema = z
  .object({
    id: z.string().min(1),
    run_id: z.string().min(1),
    uri: z.string().min(1),
    backend_id: z.string().min(1).optional(),
    backend_root: z.string().min(1).optional(),
    source_node_id: z.string().min(1).optional(),
    media_type: z.string().min(1).optional(),
    semantic_type: ArtifactSemanticTypeSchema.optional(),
    content_hash: z.string().min(1).optional(),
    content_size_bytes: z.number().int().safe().nonnegative().optional(),
    artifact_path: z.string().min(1).optional(),
    status: z.enum(["pending", "committed", "failed"]).optional(),
    attempt: z.number().int().positive().optional(),
    created_at: z.string().min(1)
  })
  .strict();

export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

export type ArtifactManifestKey = {
  id: string;
  run_id: string;
  source_node_id: string;
  artifact_path: string;
  attempt: number;
  backend_id: string;
  backend_root: string;
};

export const ARTIFACT_MANIFEST_LIST_LIMIT_MAXIMA = {
  max_entries: 100_000,
  max_entry_bytes: 4 * 1024 * 1024,
  max_total_bytes: 512 * 1024 * 1024,
  max_scanned_entries: 200_000
} as const;

export const ARTIFACT_MANIFEST_READ_MAX_BYTES = 1024 * 1024;

const ARTIFACT_MANIFEST_LIST_LIMIT_DEFAULTS: ArtifactManifestListLimits = {
  max_entries: ARTIFACT_MANIFEST_LIST_LIMIT_MAXIMA.max_entries,
  max_entry_bytes: ARTIFACT_MANIFEST_READ_MAX_BYTES,
  max_total_bytes: 256 * 1024 * 1024,
  max_scanned_entries: ARTIFACT_MANIFEST_LIST_LIMIT_MAXIMA.max_scanned_entries
};

export type ArtifactManifestListLimits = {
  readonly max_entries: number;
  readonly max_entry_bytes: number;
  readonly max_total_bytes: number;
  readonly max_scanned_entries: number;
};

export type ArtifactManifestListLimitKind =
  | "entries"
  | "entry_bytes"
  | "total_bytes"
  | "scanned_entries";

export class ArtifactManifestListLimitError extends Error {
  readonly code = "artifact_manifest_list_limit_exceeded" as const;
  readonly kind: ArtifactManifestListLimitKind;
  readonly maximum: number;

  constructor(kind: ArtifactManifestListLimitKind, maximum: number) {
    super(`Artifact manifest list exceeded its ${kind} limit`);
    this.name = "ArtifactManifestListLimitError";
    this.kind = kind;
    this.maximum = maximum;
  }
}

function positiveBoundedListLimit(
  value: number,
  label: keyof ArtifactManifestListLimits
): number {
  const maximum = ARTIFACT_MANIFEST_LIST_LIMIT_MAXIMA[label];
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

export function resolveArtifactManifestListLimits(
  input: Partial<ArtifactManifestListLimits> = {}
): ArtifactManifestListLimits {
  const limits = {
    max_entries: positiveBoundedListLimit(
      input.max_entries ?? ARTIFACT_MANIFEST_LIST_LIMIT_DEFAULTS.max_entries,
      "max_entries"
    ),
    max_entry_bytes: positiveBoundedListLimit(
      input.max_entry_bytes ?? ARTIFACT_MANIFEST_LIST_LIMIT_DEFAULTS.max_entry_bytes,
      "max_entry_bytes"
    ),
    max_total_bytes: positiveBoundedListLimit(
      input.max_total_bytes ?? ARTIFACT_MANIFEST_LIST_LIMIT_DEFAULTS.max_total_bytes,
      "max_total_bytes"
    ),
    max_scanned_entries: positiveBoundedListLimit(
      input.max_scanned_entries ??
        ARTIFACT_MANIFEST_LIST_LIMIT_DEFAULTS.max_scanned_entries,
      "max_scanned_entries"
    )
  } satisfies ArtifactManifestListLimits;

  if (limits.max_entries > limits.max_scanned_entries) {
    throw new Error("max_entries cannot exceed max_scanned_entries");
  }
  if (limits.max_entry_bytes > limits.max_total_bytes) {
    throw new Error("max_entry_bytes cannot exceed max_total_bytes");
  }
  return limits;
}

export function artifactManifestListLimitError(
  kind: ArtifactManifestListLimitKind,
  maximum: number
): ArtifactManifestListLimitError {
  return new ArtifactManifestListLimitError(kind, maximum);
}

export type ArtifactManifestStore = {
  put(manifest: ArtifactManifest): Promise<void>;
  get(key: ArtifactManifestKey): Promise<ArtifactManifest | undefined>;
  list(
    runId: string,
    limits?: Partial<ArtifactManifestListLimits>
  ): Promise<ArtifactManifest[]>;
};

export function artifactManifestKeyHash(key: ArtifactManifestKey): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: key.id,
        run_id: key.run_id,
        source_node_id: key.source_node_id,
        artifact_path: key.artifact_path,
        attempt: key.attempt,
        backend_id: key.backend_id,
        backend_root: key.backend_root
      })
    )
    .digest("hex");
}

export function artifactManifestKeyFromManifest(
  manifest: ArtifactManifest
): ArtifactManifestKey {
  return {
    id: manifest.id,
    run_id: manifest.run_id,
    source_node_id: manifest.source_node_id ?? "",
    artifact_path: manifest.artifact_path ?? "",
    attempt: manifest.attempt ?? 1,
    backend_id: manifest.backend_id ?? "",
    backend_root: manifest.backend_root ?? ""
  };
}
