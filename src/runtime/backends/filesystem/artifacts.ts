import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "../../../core/artifacts/atomic-write.js";
import type {
  ArtifactManifest,
  ArtifactManifestStore
} from "../../../core/runtime/artifacts/contracts.js";
import type { BackendRegistration } from "../../../core/runtime/backends/contracts.js";
import { safeJoin } from "../../../core/security/path.js";
import { z } from "zod";

export const FilesystemArtifactManifestBackendOptionsSchema = z
  .object({ root: z.string().min(1) })
  .strict();
export const filesystemArtifactManifestBackendRegistration = {
  id: "filesystem.artifacts",
  kind: "artifact_manifest",
  optionsSchema: FilesystemArtifactManifestBackendOptionsSchema
} satisfies BackendRegistration<z.infer<typeof FilesystemArtifactManifestBackendOptionsSchema>>;

export type FilesystemArtifactManifestStoreOptions = {
  root: string;
};

const ArtifactManifestSchema = z
  .object({
    id: z.string().min(1),
    run_id: z.string().min(1),
    uri: z.string().min(1),
    source_node_id: z.string().min(1).optional(),
    media_type: z.string().min(1).optional(),
    created_at: z.string().min(1)
  })
  .strict();

export function createFilesystemArtifactManifestStore({
  root
}: FilesystemArtifactManifestStoreOptions): ArtifactManifestStore {
  async function manifestPath(runId: string, id: string): Promise<string> {
    return await safeJoin(root, [runId, `${id}.json`]);
  }

  return {
    async put(manifest) {
      const filePath = await manifestPath(manifest.run_id, manifest.id);
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await atomicWriteFile(
        filePath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        0o600
      );
    },
    async get(id) {
      const runs = await readdir(root).catch((cause) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }

        throw cause;
      });

      for (const runId of runs) {
        const filePath = await manifestPath(runId, id);
        try {
          return ArtifactManifestSchema.parse(
            JSON.parse(await readFile(filePath, "utf8"))
          ) as ArtifactManifest;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
            throw cause;
          }
        }
      }

      return undefined;
    },
    async list(runId) {
      const runRoot = await safeJoin(root, [runId]);
      const files = await readdir(runRoot).catch((cause) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }

        throw cause;
      });

      return await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => {
            const filePath = await safeJoin(root, [runId, file]);
            return ArtifactManifestSchema.parse(
              JSON.parse(await readFile(filePath, "utf8"))
            ) as ArtifactManifest;
          })
      );
    }
  };
}
