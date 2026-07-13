import type {
  ArtifactManifest,
  ArtifactManifestStore
} from "../../../core/runtime/artifacts/contracts.js";
import {
  ArtifactManifestSchema,
  artifactManifestListLimitError,
  artifactManifestKeyFromManifest,
  artifactManifestKeyHash,
  resolveArtifactManifestListLimits
} from "../../../core/runtime/artifacts/contracts.js";
import type {
  ArtifactContentCommitInput,
  ArtifactContentStore,
  ArtifactContentWriteInput,
  ArtifactTransactionJournal,
  ArtifactTransactionRecord
} from "../../../core/runtime/artifacts/transaction.js";
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
      const parsed = ArtifactManifestSchema.parse(manifest);
      manifests.set(artifactManifestKeyHash(artifactManifestKeyFromManifest(parsed)), {
        ...parsed
      });
    },
    async get(key) {
      const manifest = manifests.get(artifactManifestKeyHash(key));

      return manifest === undefined ? undefined : { ...manifest };
    },
    async list(runId, requestedLimits) {
      const limits = resolveArtifactManifestListLimits(requestedLimits);
      const listed: ArtifactManifest[] = [];
      let scannedEntries = 0;
      let totalBytes = 0;
      for (const manifest of manifests.values()) {
        scannedEntries += 1;
        if (scannedEntries > limits.max_scanned_entries) {
          throw artifactManifestListLimitError(
            "scanned_entries",
            limits.max_scanned_entries
          );
        }
        if (manifest.run_id !== runId) {
          continue;
        }
        if (listed.length >= limits.max_entries) {
          throw artifactManifestListLimitError("entries", limits.max_entries);
        }
        const bytes = Buffer.byteLength(JSON.stringify(manifest), "utf8");
        if (bytes > limits.max_entry_bytes) {
          throw artifactManifestListLimitError("entry_bytes", limits.max_entry_bytes);
        }
        if (bytes > limits.max_total_bytes - totalBytes) {
          throw artifactManifestListLimitError("total_bytes", limits.max_total_bytes);
        }
        totalBytes += bytes;
        listed.push({ ...manifest });
      }
      return listed;
    }
  };
}

export function createMemoryArtifactContentStore(): ArtifactContentStore {
  const pending = new Map<string, {
    readonly content: string | Uint8Array;
    readonly content_hash: string;
  }>();
  const committed = new Map<string, {
    readonly content: string | Uint8Array;
    readonly content_hash: string;
  }>();

  return {
    async write(input: ArtifactContentWriteInput) {
      pending.set(input.transaction_id, {
        content: input.content,
        content_hash: input.content_hash
      });

      return {
        pending_uri: `memory-pending://${input.transaction_id}`,
        content_hash: input.content_hash
      };
    },
    async commit(input: ArtifactContentCommitInput) {
      const pendingContent = pending.get(input.transaction_id);
      if (
        pendingContent === undefined ||
        input.pending_uri !== `memory-pending://${input.transaction_id}` ||
        pendingContent.content_hash !== input.content_hash
      ) {
        const error = new Error(
          `Artifact ${input.artifact_id} pending content does not match the commit request.`
        ) as Error & { code: "artifact_pending_content_invalid" };
        error.code = "artifact_pending_content_invalid";
        throw error;
      }

      const key = `${input.run_id}/${input.artifact_path}`;
      const existing = committed.get(key);
      if (
        existing !== undefined &&
        existing.content_hash !== input.content_hash &&
        input.overwrite_policy === "forbid"
      ) {
        const error = new Error(
          `Artifact ${input.artifact_id} already exists with different content.`
        ) as Error & { code: "artifact_content_conflict" };
        error.code = "artifact_content_conflict";
        throw error;
      }

      committed.set(key, pendingContent);
      pending.delete(input.transaction_id);

      return {
        uri: `artifact://${input.run_id}/${input.artifact_path}`,
        content_hash: input.content_hash
      };
    },
    async read(input) {
      const stored = committed.get(`${input.run_id}/${input.artifact_path}`);
      if (stored === undefined) {
        throw new Error(`Artifact content is unavailable: ${input.artifact_path}`);
      }
      return typeof stored.content === "string"
        ? Buffer.from(stored.content, "utf8")
        : new Uint8Array(stored.content);
    }
  };
}

export function createMemoryArtifactTransactionJournal(): ArtifactTransactionJournal {
  const records = new Map<string, ArtifactTransactionRecord>();

  return {
    async get(transactionId) {
      return records.get(transactionId);
    },
    async put(record) {
      records.set(record.transaction_id, record);
    }
  };
}
