import { createHash } from "node:crypto";
import { runGit } from "../git/client.js";
import { unique } from "./file-analysis.js";
import {
  repositoryContextPolicyMatcher,
  repositoryIndexPolicyMaterial,
  repositoryIndexCapacityError,
  REPOSITORY_INDEX_RESOURCE_POLICY,
  REPOSITORY_INDEXER_VERSION,
  RepositoryIndexSnapshotChangedError
} from "./repository-index-policy.js";
import { openFileBeneath } from "../../core/security/secure-root-file.js";
import { gitNulFields, gitOutputDigest } from "./repository-index-git-stream.js";
import { classifyCandidateBytes } from "./candidate-reader.js";
import type { RepositoryContextIndexPolicy } from "./repository-index-policy.js";

const STREAM_CHUNK_BYTES = 64 * 1024;

export type RepositorySnapshotIdentity = {
  readonly id: string;
  readonly headSha: string;
  readonly dirty: boolean;
  readonly policyHash: string;
  readonly inventory: readonly string[];
  readonly inventoryPathBytes: number;
  readonly eligible: readonly string[];
  readonly unavailable: readonly string[];
  readonly policyExcluded: readonly string[];
  readonly nonRegularExcluded: readonly string[];
  readonly binaryExcluded: readonly string[];
  readonly sensitiveExcluded: readonly string[];
  readonly contentFingerprints: ReadonlyMap<string, string>;
  readonly contentSources: ReadonlyMap<string, RepositoryContentSource>;
  readonly fingerprintedContentBytes: number;
};

export type RepositoryContentSource =
  | { readonly kind: "git_blob"; readonly oid: string; readonly mode: "100644" | "100755" }
  | { readonly kind: "worktree"; readonly fingerprint: string };

function digest(parts: readonly (string | Buffer)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function hashRepositoryFile(
  root: string,
  filePath: string,
  hash: ReturnType<typeof createHash>,
  signal?: AbortSignal
): Promise<{ readonly bytes: number; readonly classification?: "binary" | "sensitive" }> {
  signal?.throwIfAborted();
  const handle = await openFileBeneath(root, filePath).catch((cause: unknown) => {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") {
      return undefined;
    }
    throw cause;
  });
  if (handle === undefined) {
    hash.update("<missing>");
    return { bytes: 0 };
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      hash.update("<non-regular>");
      return { bytes: 0 };
    }
    if (before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw repositoryIndexCapacityError({
        phase: "preflight",
        resource: "file_source_bytes",
        observed: before.size > BigInt(Number.MAX_SAFE_INTEGER)
          ? Number.MAX_SAFE_INTEGER
          : Number(before.size),
        limit: REPOSITORY_INDEX_RESOURCE_POLICY.max_file_source_bytes,
        path: filePath
      });
    }
    if (before.size > BigInt(REPOSITORY_INDEX_RESOURCE_POLICY.max_file_source_bytes)) {
      const prefix = Buffer.alloc(Math.min(Number(before.size), STREAM_CHUNK_BYTES));
      const read = await handle.read(prefix, 0, prefix.length, 0);
      const classification = classifyCandidateBytes(
        prefix.subarray(0, read.bytesRead),
        { prefix: true }
      );
      if (classification === "binary" || classification === "sensitive") {
        hash.update(`<${classification}>`);
        return { bytes: read.bytesRead, classification };
      }
      throw repositoryIndexCapacityError({
        phase: "preflight",
        resource: "file_source_bytes",
        observed: Number(before.size),
        limit: REPOSITORY_INDEX_RESOURCE_POLICY.max_file_source_bytes,
        path: filePath
      });
    }
    const buffer = Buffer.alloc(STREAM_CHUNK_BYTES);
    let position = 0;
    const expectedBytes = Number(before.size);
    while (position < expectedBytes) {
      signal?.throwIfAborted();
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, expectedBytes - position),
        position
      );
      if (read.bytesRead === 0) {
        throw new RepositoryIndexSnapshotChangedError(filePath);
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs
    ) {
      throw new RepositoryIndexSnapshotChangedError(filePath);
    }
    return { bytes: expectedBytes };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function repositoryContentDigest(
  root: string,
  paths: readonly string[],
  signal?: AbortSignal
): Promise<{
  readonly digest: string;
  readonly fingerprints: ReadonlyMap<string, string>;
  readonly binaryExcluded: readonly string[];
  readonly sensitiveExcluded: readonly string[];
  readonly bytes: number;
}> {
  const hash = createHash("sha256");
  const fingerprints = new Map<string, string>();
  const binaryExcluded: string[] = [];
  const sensitiveExcluded: string[] = [];
  let bytes = 0;
  for (const filePath of paths) {
    signal?.throwIfAborted();
    hash.update(filePath);
    hash.update("\0");
    const fileHash = createHash("sha256");
    const hashed = await hashRepositoryFile(root, filePath, fileHash, signal);
    bytes += hashed.bytes;
    if (hashed.classification === "binary") binaryExcluded.push(filePath);
    if (hashed.classification === "sensitive") sensitiveExcluded.push(filePath);
    const fingerprint = fileHash.digest("hex");
    fingerprints.set(filePath, fingerprint);
    hash.update(fingerprint);
    hash.update("\0");
  }
  return {
    digest: hash.digest("hex"),
    fingerprints,
    binaryExcluded,
    sensitiveExcluded,
    bytes
  };
}

export async function repositorySnapshotIdentity(
  root: string,
  policy?: RepositoryContextIndexPolicy,
  signal?: AbortSignal
): Promise<RepositorySnapshotIdentity> {
  signal?.throwIfAborted();
  const insideWorkTree = (await runGit(root, ["rev-parse", "--is-inside-work-tree"])).trim();
  if (insideWorkTree !== "true") {
    throw new Error(`Repository context root is not a Git worktree: ${root}`);
  }
  const inventoryOutput = await gitNulFields({
    root,
    args: ["ls-files", "-co", "--exclude-standard", "-z"],
    maxBytes: REPOSITORY_INDEX_RESOURCE_POLICY.max_inventory_output_bytes,
    maxEntries: REPOSITORY_INDEX_RESOURCE_POLICY.max_inventory_entries,
    phase: "inventory",
    signal
  });
  const inventory = unique(inventoryOutput.fields).sort();
  const deletedOutput = await gitNulFields({
    root,
    args: ["ls-files", "--deleted", "-z"],
    maxBytes: REPOSITORY_INDEX_RESOURCE_POLICY.max_inventory_output_bytes,
    maxEntries: REPOSITORY_INDEX_RESOURCE_POLICY.max_inventory_entries,
    phase: "inventory",
    signal
  });
  const deleted = new Set(deletedOutput.fields);
  const isPolicyExcluded = repositoryContextPolicyMatcher(policy);
  const policyExcluded = inventory.filter(isPolicyExcluded);
  // File extensions are metadata, never an eligibility gate. Every
  // non-sensitive repository file is classified from its captured bytes so
  // unfamiliar languages and extensionless build files remain discoverable.
  const discoverable = inventory.filter((file) =>
    !isPolicyExcluded(file) && !deleted.has(file)
  );
  const unavailable = inventory.filter((file) =>
    !isPolicyExcluded(file) && deleted.has(file)
  );

  let headSha: string;
  try {
    headSha = (await runGit(root, ["rev-parse", "--verify", "HEAD"])).trim();
  } catch (cause) {
    await runGit(root, ["symbolic-ref", "HEAD"]).catch(() => {
      throw cause;
    });
    headSha = "unborn";
  }
  const [indexEntries, status, unstaged, untracked] = await Promise.all([
    gitNulFields({
      root,
      args: ["ls-files", "-s", "-z"],
      maxBytes: REPOSITORY_INDEX_RESOURCE_POLICY.max_git_metadata_bytes,
      maxEntries: REPOSITORY_INDEX_RESOURCE_POLICY.max_inventory_entries,
      phase: "preflight",
      signal
    }),
    gitOutputDigest(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal),
    gitNulFields({
      root,
      args: ["diff", "--name-only", "-z", "--"],
      maxBytes: REPOSITORY_INDEX_RESOURCE_POLICY.max_inventory_output_bytes,
      maxEntries: REPOSITORY_INDEX_RESOURCE_POLICY.max_inventory_entries,
      phase: "preflight",
      signal
    }),
    gitNulFields({
      root,
      args: ["ls-files", "--others", "--exclude-standard", "-z"],
      maxBytes: REPOSITORY_INDEX_RESOURCE_POLICY.max_inventory_output_bytes,
      maxEntries: REPOSITORY_INDEX_RESOURCE_POLICY.max_inventory_entries,
      phase: "preflight",
      signal
    })
  ]);
  const eligibleSet = new Set(discoverable);
  const tracked = new Map<string, Extract<RepositoryContentSource, { kind: "git_blob" }>>();
  const nonRegularExcluded = new Set<string>();
  for (const entry of indexEntries.fields) {
    const separator = entry.indexOf("\t");
    const metadata = separator === -1 ? [] : entry.slice(0, separator).split(" ");
    const filePath = separator === -1 ? "" : entry.slice(separator + 1);
    const [mode, oid, stage] = metadata;
    if (stage !== "0") {
      if (eligibleSet.has(filePath)) {
        throw new Error(`Repository index rejected non-blob or conflicted entry: ${filePath}`);
      }
      continue;
    }
    if ((mode !== "100644" && mode !== "100755") || oid === undefined) {
      if (eligibleSet.has(filePath)) {
        nonRegularExcluded.add(filePath);
      }
      continue;
    }
    tracked.set(filePath, { kind: "git_blob", oid, mode });
  }
  const initiallyEligible = discoverable.filter((file) => !nonRegularExcluded.has(file));
  const worktreePaths = new Set(unique([...unstaged.fields, ...untracked.fields]));
  const worktreeEligible = initiallyEligible.filter((file) => worktreePaths.has(file));
  const content = await repositoryContentDigest(root, worktreeEligible, signal);
  const binaryExcluded = new Set(content.binaryExcluded);
  const sensitiveExcluded = new Set(content.sensitiveExcluded);
  const eligible = initiallyEligible.filter((file) =>
    !binaryExcluded.has(file) && !sensitiveExcluded.has(file)
  );
  const contentSources = new Map<string, RepositoryContentSource>();
  for (const file of eligible) {
    const fingerprint = content.fingerprints.get(file);
    if (fingerprint !== undefined) {
      contentSources.set(file, { kind: "worktree", fingerprint });
      continue;
    }
    const blob = tracked.get(file);
    if (blob === undefined) {
      throw new RepositoryIndexSnapshotChangedError(file);
    }
    contentSources.set(file, blob);
  }
  const policyHash = digest([repositoryIndexPolicyMaterial(policy)]);
  const id = digest([
    REPOSITORY_INDEXER_VERSION,
    policyHash,
    headSha,
    inventory.join("\0"),
    digest(indexEntries.fields),
    status.digest,
    content.digest
  ]);

  return {
    id,
    headSha,
    dirty: status.nonempty,
    policyHash,
    inventory,
    inventoryPathBytes: inventoryOutput.bytes,
    eligible,
    unavailable,
    policyExcluded,
    nonRegularExcluded: [...nonRegularExcluded].sort(),
    binaryExcluded: [...binaryExcluded].sort(),
    sensitiveExcluded: [...sensitiveExcluded].sort(),
    contentFingerprints: content.fingerprints,
    contentSources,
    fingerprintedContentBytes: content.bytes
  };
}
