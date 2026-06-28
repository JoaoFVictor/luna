import { createHash } from "node:crypto";

export type ArtifactManifest = {
  id: string;
  run_id: string;
  uri: string;
  backend_id?: string;
  backend_root?: string;
  source_node_id?: string;
  media_type?: string;
  content_hash?: string;
  artifact_path?: string;
  status?: "pending" | "committed" | "failed";
  attempt?: number;
  created_at: string;
};

export type ArtifactManifestKey = {
  id: string;
  run_id: string;
  source_node_id: string;
  artifact_path: string;
  attempt: number;
  backend_id: string;
  backend_root: string;
};

export type ArtifactManifestStore = {
  put(manifest: ArtifactManifest): Promise<void>;
  get(key: ArtifactManifestKey): Promise<ArtifactManifest | undefined>;
  list(runId: string): Promise<ArtifactManifest[]>;
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
