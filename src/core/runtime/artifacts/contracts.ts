export type ArtifactManifest = {
  id: string;
  run_id: string;
  uri: string;
  source_node_id?: string;
  media_type?: string;
  created_at: string;
};

export type ArtifactManifestStore = {
  put(manifest: ArtifactManifest): Promise<void>;
  get(id: string): Promise<ArtifactManifest | undefined>;
  list(runId: string): Promise<ArtifactManifest[]>;
};
