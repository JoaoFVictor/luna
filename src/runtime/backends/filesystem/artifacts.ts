import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "../../../core/artifacts/atomic-write.js";
import type {
  ArtifactManifest,
  ArtifactManifestListLimits,
  ArtifactManifestStore
} from "../../../core/runtime/artifacts/contracts.js";
import {
  ArtifactManifestSchema,
  artifactManifestListLimitError,
  artifactManifestKeyFromManifest,
  artifactManifestKeyHash,
  resolveArtifactManifestListLimits
} from "../../../core/runtime/artifacts/contracts.js";
import { isReservedFilesystemArtifactPath } from "../../../core/runtime/artifacts/filesystem-paths.js";
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

const MANIFEST_FILENAME_PATTERN = /^[a-f0-9]{64}\.json$/;

async function readBoundedManifestFile(
  filePath: string,
  limits: ArtifactManifestListLimits,
  consumedBytes: number
): Promise<{ readonly manifest: ArtifactManifest; readonly bytes: number }> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 0n ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Artifact manifest is not a supported regular file");
    }
    const bytes = Number(before.size);
    if (bytes > limits.max_entry_bytes) {
      throw artifactManifestListLimitError("entry_bytes", limits.max_entry_bytes);
    }
    if (bytes > limits.max_total_bytes - consumedBytes) {
      throw artifactManifestListLimitError("total_bytes", limits.max_total_bytes);
    }

    const content = Buffer.alloc(bytes);
    let offset = 0;
    while (offset < bytes) {
      const read = await handle.read(content, offset, bytes - offset, offset);
      if (read.bytesRead === 0) {
        throw new Error("Artifact manifest changed while it was being read");
      }
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs
    ) {
      throw new Error("Artifact manifest changed while it was being read");
    }

    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    return {
      manifest: ArtifactManifestSchema.parse(JSON.parse(text)) as ArtifactManifest,
      bytes
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

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
      const parsed = ArtifactManifestSchema.parse(manifest);
      const filePath = await scopedManifestPath(parsed);
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await atomicWriteFile(
        filePath,
        `${JSON.stringify(parsed, null, 2)}\n`,
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
    async list(runId, requestedLimits) {
      const limits = resolveArtifactManifestListLimits(requestedLimits);
      const manifestRoot = await safeJoin(root, [runId, ".manifests"]);
      const directory = await opendir(manifestRoot).catch((cause) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }

        throw cause;
      });
      if (directory === undefined) {
        return [];
      }

      const manifests: ArtifactManifest[] = [];
      let scannedEntries = 0;
      let totalBytes = 0;
      try {
        // Deliberately sequential: both open descriptors and aggregate memory
        // remain inside the caller's budgets throughout the directory scan.
        for await (const entry of directory) {
          scannedEntries += 1;
          if (scannedEntries > limits.max_scanned_entries) {
            throw artifactManifestListLimitError(
              "scanned_entries",
              limits.max_scanned_entries
            );
          }
          if (!MANIFEST_FILENAME_PATTERN.test(entry.name)) {
            continue;
          }
          if (!entry.isFile()) {
            throw new Error("Artifact manifest entry is not a regular file");
          }
          if (manifests.length >= limits.max_entries) {
            throw artifactManifestListLimitError("entries", limits.max_entries);
          }

          const filePath = await safeJoin(root, [runId, ".manifests", entry.name]);
          const loaded = await readBoundedManifestFile(filePath, limits, totalBytes);
          totalBytes += loaded.bytes;
          manifests.push(loaded.manifest);
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
      return manifests;
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

      if (
        existingHash !== undefined &&
        existingHash !== input.content_hash &&
        input.overwrite_policy === "forbid"
      ) {
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
    },
    async read(input) {
      return new Uint8Array(await readFile(await committedPath(input)));
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
  if (isReservedFilesystemArtifactPath(artifactPath)) {
    const error = new Error(
      `Artifact path ${artifactPath} uses a reserved filesystem artifact directory.`
    ) as Error & {
      code: "path_security_violation";
    };
    error.code = "path_security_violation";
    throw error;
  }
}
