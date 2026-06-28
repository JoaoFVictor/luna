import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "../../../core/artifacts/atomic-write.js";
import type {
  ArtifactManifest,
  ArtifactManifestStore
} from "../../../core/runtime/artifacts/contracts.js";
import {
  artifactManifestKeyFromManifest,
  artifactManifestKeyHash
} from "../../../core/runtime/artifacts/contracts.js";
import type {
  ArtifactContentCommitInput,
  ArtifactContentStore,
  ArtifactContentWriteInput,
  ArtifactTransactionJournal,
  ArtifactTransactionRecord
} from "../../../core/runtime/artifacts/transaction.js";
import { hashArtifactContent } from "../../../core/runtime/artifacts/transaction.js";
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
    backend_id: z.string().min(1).optional(),
    backend_root: z.string().min(1).optional(),
    source_node_id: z.string().min(1).optional(),
    media_type: z.string().min(1).optional(),
    content_hash: z.string().min(1).optional(),
    artifact_path: z.string().min(1).optional(),
    status: z.enum(["pending", "committed", "failed"]).optional(),
    attempt: z.number().int().positive().optional(),
    created_at: z.string().min(1)
  })
  .strict();

export function createFilesystemArtifactManifestStore({
  root
}: FilesystemArtifactManifestStoreOptions): ArtifactManifestStore {
  async function scopedManifestPath(manifest: ArtifactManifest): Promise<string> {
    return await safeJoin(root, [
      manifest.run_id,
      ".manifests",
      `${manifestKeyHash(manifest)}.json`
    ]);
  }

  return {
    async put(manifest) {
      const filePath = await scopedManifestPath(manifest);
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await atomicWriteFile(
        filePath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        0o600
      );
    },
    async get(key) {
      const filePath = await scopedManifestPath({
        id: key.id,
        run_id: key.run_id,
        source_node_id: key.source_node_id,
        artifact_path: key.artifact_path,
        attempt: key.attempt,
        backend_id: key.backend_id,
        backend_root: key.backend_root,
        uri: "lookup://manifest",
        created_at: "lookup"
      });
      try {
        return ArtifactManifestSchema.parse(
          JSON.parse(await readFile(filePath, "utf8"))
        ) as ArtifactManifest;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw cause;
      }
    },
    async list(runId) {
      const manifestRoot = await safeJoin(root, [runId, ".manifests"]);
      const files = await readdir(manifestRoot).catch((cause) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }

        throw cause;
      });

      return await Promise.all(
        files
          .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
          .map(async (file) => {
            const filePath = await safeJoin(root, [runId, ".manifests", file]);
            return ArtifactManifestSchema.parse(
              JSON.parse(await readFile(filePath, "utf8"))
            ) as ArtifactManifest;
          })
      );
    }
  };
}

function manifestKeyHash(manifest: ArtifactManifest): string {
  return artifactManifestKeyHash(artifactManifestKeyFromManifest(manifest));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createFilesystemArtifactContentStore({
  root
}: FilesystemArtifactManifestStoreOptions): ArtifactContentStore {
  async function pendingPath(input: {
    readonly run_id: string;
    readonly transaction_id: string;
  }): Promise<string> {
    return await safeJoin(root, [
      input.run_id,
      ".pending",
      `${hashText(input.transaction_id)}.artifact`
    ]);
  }

  async function committedPath(input: {
    readonly run_id: string;
    readonly artifact_path: string;
  }): Promise<string> {
    assertNonReservedArtifactPath(input.artifact_path);
    return await safeJoin(root, [input.run_id, ...input.artifact_path.split("/")]);
  }

  return {
    async validateWrite(input: ArtifactContentWriteInput) {
      await committedPath(input);
    },
    async write(input: ArtifactContentWriteInput) {
      await committedPath(input);
      const filePath = await pendingPath(input);
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await writeFile(filePath, input.content, { mode: 0o600 });

      return {
        pending_uri: pendingUri(input.transaction_id),
        content_hash: hashArtifactContent(input.content)
      };
    },
    async commit(input: ArtifactContentCommitInput) {
      if (input.overwrite_policy === "version") {
        throw unsupportedVersionPolicy(input.artifact_id);
      }

      const to = await committedPath(input);
      await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });

      const existingHash = await readFile(to)
        .then((content) => hashArtifactContent(content))
        .catch((cause) => {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw cause;
        });

      if (existingHash === input.content_hash) {
        return {
          uri: `artifact://${input.run_id}/${input.artifact_path}`,
          content_hash: existingHash
        };
      }

      const from = await pendingPath(input);
      if (input.pending_uri !== pendingUri(input.transaction_id)) {
        throw invalidPendingContent(input.artifact_id);
      }
      const pendingHash = await readFile(from)
        .then((content) => hashArtifactContent(content))
        .catch((cause) => {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
            throw invalidPendingContent(input.artifact_id);
          }
          throw cause;
        });
      if (pendingHash !== input.content_hash) {
        throw invalidPendingContent(input.artifact_id);
      }

      if (existingHash !== undefined && input.overwrite_policy === "forbid") {
        const error = new Error(
          `Artifact ${input.artifact_id} already exists with different content.`
        ) as Error & {
          code: "artifact_content_conflict";
        };
        error.code = "artifact_content_conflict";
        throw error;
      }
      await rename(from, to);

      return {
        uri: `artifact://${input.run_id}/${input.artifact_path}`,
        content_hash: input.content_hash
      };
    }
  };
}

export function createFilesystemArtifactTransactionJournal({
  root
}: FilesystemArtifactManifestStoreOptions): ArtifactTransactionJournal {
  async function recordPath(transactionId: string): Promise<string> {
    return await safeJoin(root, [
      ".artifact-transactions",
      `${hashText(transactionId)}.json`
    ]);
  }

  return {
    async get(transactionId) {
      try {
        return JSON.parse(
          await readFile(await recordPath(transactionId), "utf8")
        ) as ArtifactTransactionRecord;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw cause;
      }
    },
    async put(record) {
      const filePath = await recordPath(record.transaction_id);
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await atomicWriteFile(filePath, `${JSON.stringify(record, null, 2)}\n`, 0o600);
    }
  };
}

function unsupportedVersionPolicy(artifactId: string): Error & {
  code: "artifact_overwrite_policy_unsupported";
} {
  const error = new Error(
    `Artifact ${artifactId} version overwrite is not supported by filesystem artifacts.`
  ) as Error & {
    code: "artifact_overwrite_policy_unsupported";
  };
  error.code = "artifact_overwrite_policy_unsupported";
  return error;
}

function invalidPendingContent(artifactId: string): Error & {
  code: "artifact_pending_content_invalid";
} {
  const error = new Error(
    `Artifact ${artifactId} pending content does not match the commit request.`
  ) as Error & {
    code: "artifact_pending_content_invalid";
  };
  error.code = "artifact_pending_content_invalid";
  return error;
}

function pendingUri(transactionId: string): string {
  return `filesystem-pending://${hashText(transactionId)}`;
}

function assertNonReservedArtifactPath(artifactPath: string): void {
  const [firstSegment] = artifactPath.split("/");
  if (firstSegment === ".manifests" || firstSegment === ".pending") {
    const error = new Error(
      `Artifact path ${artifactPath} uses a reserved filesystem artifact directory.`
    ) as Error & {
      code: "path_security_violation";
    };
    error.code = "path_security_violation";
    throw error;
  }
}
