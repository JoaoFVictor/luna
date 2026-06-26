import type {
  ArtifactManifest,
  ArtifactManifestStore
} from "../../../core/runtime/artifacts/contracts.js";
import type { BackendRegistration } from "../../../core/runtime/backends/contracts.js";
import { z } from "zod";

export const MemoryArtifactManifestBackendOptionsSchema = z.object({}).strict();
export const memoryArtifactManifestBackendRegistration = {
  id: "memory.artifacts",
  kind: "artifact_manifest",
  optionsSchema: MemoryArtifactManifestBackendOptionsSchema
} satisfies BackendRegistration<z.infer<typeof MemoryArtifactManifestBackendOptionsSchema>>;

export function createMemoryArtifactManifestStore(): ArtifactManifestStore {
  const manifests = new Map<string, ArtifactManifest>();

  return {
    async put(manifest) {
      manifests.set(manifest.id, { ...manifest });
    },
    async get(id) {
      const manifest = manifests.get(id);

      return manifest === undefined ? undefined : { ...manifest };
    },
    async list(runId) {
      return [...manifests.values()]
        .filter((manifest) => manifest.run_id === runId)
        .map((manifest) => ({ ...manifest }));
    }
  };
}
