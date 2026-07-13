import { createHash } from "node:crypto";
import path from "node:path";
import {
  ArtifactSemanticTypeSchema,
  type ArtifactSemanticType
} from "../../artifacts/semantic-type.js";
import type {
  ArtifactManifestKey,
  ArtifactManifest,
  ArtifactManifestStore
} from "./contracts.js";

export type ArtifactOverwritePolicy = "forbid" | "replace" | "version";

export type ArtifactTransactionStage =
  | "pending_manifest_created"
  | "content_written"
  | "content_committed"
  | "manifest_updated"
  | "steps_published"
  | "checkpoint_marked";

export type ArtifactTransactionRecord = {
  readonly transaction_id: string;
  readonly run_id: string;
  readonly node_id: string;
  readonly artifact_id: string;
  readonly artifact_path: string;
  readonly backend_id: string;
  readonly backend_root: string;
  readonly overwrite_policy: ArtifactOverwritePolicy;
  readonly content_hash: string;
  readonly content_size_bytes?: number;
  readonly attempt: number;
  readonly media_type?: string;
  readonly semantic_type?: ArtifactSemanticType;
  readonly stage: ArtifactTransactionStage;
  readonly pending_uri?: string;
  readonly committed_uri?: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export type ArtifactTransactionJournal = {
  get(transactionId: string): Promise<ArtifactTransactionRecord | undefined>;
  put(record: ArtifactTransactionRecord): Promise<void>;
};

export type ArtifactContentWriteInput = {
  readonly transaction_id: string;
  readonly run_id: string;
  readonly node_id: string;
  readonly artifact_id: string;
  readonly artifact_path: string;
  readonly content: string | Uint8Array;
  readonly content_hash: string;
  readonly media_type?: string;
  readonly semantic_type?: ArtifactSemanticType;
};

export type ArtifactContentCommitInput = {
  readonly transaction_id: string;
  readonly run_id: string;
  readonly node_id: string;
  readonly artifact_id: string;
  readonly artifact_path: string;
  readonly pending_uri: string;
  readonly content_hash: string;
  readonly overwrite_policy: ArtifactOverwritePolicy;
};

export type ArtifactContentStore = {
  validateWrite?(input: ArtifactContentWriteInput): Promise<void>;
  write(input: ArtifactContentWriteInput): Promise<{
    readonly pending_uri: string;
    readonly content_hash?: string;
  }>;
  commit(input: ArtifactContentCommitInput): Promise<{
    readonly uri: string;
    readonly content_hash?: string;
  }>;
  read?(input: {
    readonly run_id: string;
    readonly artifact_path: string;
    readonly max_bytes?: number;
  }): Promise<Uint8Array>;
};

export type ArtifactStepsPublisher = {
  publishArtifactRef(ref: ArtifactManifest): Promise<void>;
};

export type ArtifactCheckpointMarker = {
  markArtifactCheckpointed(ref: ArtifactManifest): Promise<void>;
};

export type ArtifactTransactionInput = {
  readonly run_id: string;
  readonly node_id: string;
  readonly artifact_id: string;
  readonly artifact_path: string;
  readonly content: string | Uint8Array;
  readonly media_type?: string;
  readonly semantic_type?: ArtifactSemanticType;
  readonly overwrite_policy?: ArtifactOverwritePolicy;
  readonly attempt?: number;
  readonly backend: {
    readonly id: string;
    readonly root: string;
    readonly overwrite_policy?: ArtifactOverwritePolicy;
  };
  readonly manifestStore: ArtifactManifestStore;
  readonly transactionJournal: ArtifactTransactionJournal;
  readonly contentStore: ArtifactContentStore;
  readonly stepsPublisher: ArtifactStepsPublisher;
  readonly checkpointMarker: ArtifactCheckpointMarker;
  readonly now?: () => string;
};

export type ArtifactTransactionResult = {
  readonly manifest: ArtifactManifest;
  readonly record: ArtifactTransactionRecord;
  readonly replayed: boolean;
};

type ArtifactTransactionErrorCode =
  | "path_security_violation"
  | "artifact_overwrite_policy_required"
  | "artifact_content_conflict"
  | "artifact_semantic_type_conflict"
  | "artifact_semantic_type_invalid"
  | "artifact_overwrite_policy_unsupported"
  | "artifact_pending_content_invalid"
  | "artifact_transaction_invalid";

export class ArtifactTransactionError extends Error {
  readonly code: ArtifactTransactionErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ArtifactTransactionErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ArtifactTransactionError";
    this.code = code;
    this.details = details;
  }
}

export async function publishArtifactTransaction(
  input: ArtifactTransactionInput
): Promise<ArtifactTransactionResult> {
  assertSafeArtifactPath(input.artifact_path);
  assertArtifactSemanticType(input.semantic_type);

  const overwritePolicy = explicitOverwritePolicy(input);
  rejectUnsupportedOverwritePolicy(overwritePolicy);
  const contentHash = hashArtifactContent(input.content);
  const contentSizeBytes = artifactContentSize(input.content);
  const transactionId = transactionIdFor(input);
  const now = input.now ?? (() => new Date().toISOString());
  const manifestKey = manifestKeyFor(input);
  const existing = await input.manifestStore.get(manifestKey);
  const journalRecord = await input.transactionJournal.get(transactionId);
  const existingTransaction =
    journalRecord?.attempt === (input.attempt ?? 1) &&
    journalRecord.content_hash === contentHash &&
    journalRecord.semantic_type === input.semantic_type
      ? journalRecord
      : undefined;
  const existingHash = existing?.content_hash;
  await input.contentStore.validateWrite?.({
    transaction_id: transactionId,
    run_id: input.run_id,
    node_id: input.node_id,
    artifact_id: input.artifact_id,
    artifact_path: input.artifact_path,
    content: input.content,
    content_hash: contentHash,
    ...(input.media_type === undefined ? {} : { media_type: input.media_type }),
    ...(input.semantic_type === undefined
      ? {}
      : { semantic_type: input.semantic_type })
  });

  if (
    manifestMatchesTransactionInput(existing, input) &&
    existing?.status === "committed" &&
    existingHash === contentHash &&
    existing.attempt === (input.attempt ?? 1) &&
    existingTransaction?.stage === "checkpoint_marked" &&
    existing.uri === existingTransaction.committed_uri
  ) {
    return {
      manifest: existing,
      record: checkpointedRecordFromManifest({
        input,
        manifest: existing,
        contentHash,
        contentSizeBytes,
        overwritePolicy,
        transactionId,
        now: now()
      }),
      replayed: true
    };
  }

  if (
    manifestMatchesTransactionIdentity(existing, input) &&
    existing?.status === "committed" &&
    existing.semantic_type !== input.semantic_type
  ) {
    throw new ArtifactTransactionError(
      "artifact_semantic_type_conflict",
      `Artifact ${input.artifact_id} already exists with different semantic metadata.`,
      { artifact_id: input.artifact_id }
    );
  }

  if (
    manifestMatchesTransactionIdentity(existing, input) &&
    existingHash !== contentHash &&
    overwritePolicy === "forbid"
  ) {
    throw new ArtifactTransactionError(
      "artifact_content_conflict",
      `Artifact ${input.artifact_id} already exists with different content.`,
      {
        artifact_id: input.artifact_id,
        existing_content_hash: existingHash,
        content_hash: contentHash
      }
    );
  }

  let record =
    existingTransaction ??
    adoptCommittedManifest({
      input,
      manifest: existing,
      contentHash,
      contentSizeBytes,
      overwritePolicy,
      transactionId,
      now: now()
    }) ??
    (await createPendingManifest({
      input,
      transactionId,
      contentHash,
      contentSizeBytes,
      overwritePolicy,
      now
    }));

  record = await ensureContentWritten(input, record, now);
  record = await ensureContentCommitted(input, record, now);
  const manifest = manifestFromRecord(record);
  record = await ensureManifestUpdated(input, record, manifest, now);
  record = await ensureStepsPublished(input, record, manifest, now);
  record = await ensureCheckpointMarked(input, record, manifest, now);

  return { manifest, record, replayed: false };
}

export function hashArtifactContent(content: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(content);
  return `sha256:${hash.digest("hex")}`;
}

function artifactContentSize(content: string | Uint8Array): number {
  return typeof content === "string"
    ? new TextEncoder().encode(content).byteLength
    : content.byteLength;
}

export function assertSafeArtifactPath(artifactPath: string): void {
  if (
    artifactPath === "" ||
    artifactPath === "." ||
    path.isAbsolute(artifactPath) ||
    artifactPath.includes("\\")
  ) {
    throw new ArtifactTransactionError(
      "path_security_violation",
      `Unsafe artifact path: ${artifactPath}`,
      { artifact_path: artifactPath }
    );
  }

  const segments = artifactPath.split("/");
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ArtifactTransactionError(
      "path_security_violation",
      `Unsafe artifact path: ${artifactPath}`,
      { artifact_path: artifactPath }
    );
  }
}

function assertArtifactSemanticType(
  semanticType: ArtifactSemanticType | undefined
): void {
  if (
    semanticType !== undefined &&
    !ArtifactSemanticTypeSchema.safeParse(semanticType).success
  ) {
    throw new ArtifactTransactionError(
      "artifact_semantic_type_invalid",
      "Artifact semantic type is invalid."
    );
  }
}

function explicitOverwritePolicy(
  input: ArtifactTransactionInput
): ArtifactOverwritePolicy {
  const policy = input.overwrite_policy ?? input.backend.overwrite_policy;
  if (policy === undefined) {
    throw new ArtifactTransactionError(
      "artifact_overwrite_policy_required",
      `Artifact ${input.artifact_id} must declare overwrite behavior.`,
      { artifact_id: input.artifact_id }
    );
  }
  return policy;
}

function rejectUnsupportedOverwritePolicy(policy: ArtifactOverwritePolicy): void {
  if (policy === "version") {
    throw new ArtifactTransactionError(
      "artifact_overwrite_policy_unsupported",
      "Artifact overwrite policy version is not supported yet."
    );
  }
}

async function createPendingManifest({
  input,
  transactionId,
  contentHash,
  contentSizeBytes,
  overwritePolicy,
  now
}: {
  input: ArtifactTransactionInput;
  transactionId: string;
  contentHash: string;
  contentSizeBytes: number;
  overwritePolicy: ArtifactOverwritePolicy;
  now: () => string;
}): Promise<ArtifactTransactionRecord> {
  const timestamp = now();
  const record: ArtifactTransactionRecord = {
    transaction_id: transactionId,
    run_id: input.run_id,
    node_id: input.node_id,
    artifact_id: input.artifact_id,
    artifact_path: input.artifact_path,
    backend_id: input.backend.id,
    backend_root: input.backend.root,
    overwrite_policy: overwritePolicy,
    content_hash: contentHash,
    content_size_bytes: contentSizeBytes,
    attempt: input.attempt ?? 1,
    ...(input.media_type === undefined ? {} : { media_type: input.media_type }),
    ...(input.semantic_type === undefined
      ? {}
      : { semantic_type: input.semantic_type }),
    stage: "pending_manifest_created",
    created_at: timestamp,
    updated_at: timestamp
  };
  await input.manifestStore.put(pendingManifestFromRecord(record));
  await input.transactionJournal.put(record);
  return record;
}

async function ensureContentWritten(
  input: ArtifactTransactionInput,
  record: ArtifactTransactionRecord,
  now: () => string
): Promise<ArtifactTransactionRecord> {
  if (stageIndex(record.stage) >= stageIndex("content_written")) {
    return record;
  }

  const written = await input.contentStore.write({
    transaction_id: record.transaction_id,
    run_id: record.run_id,
    node_id: record.node_id,
    artifact_id: record.artifact_id,
    artifact_path: record.artifact_path,
    content: input.content,
    content_hash: record.content_hash,
    ...(record.media_type === undefined ? {} : { media_type: record.media_type }),
    ...(record.semantic_type === undefined
      ? {}
      : { semantic_type: record.semantic_type })
  });
  const next = advance(record, "content_written", now, {
    pending_uri: written.pending_uri,
    content_hash: written.content_hash ?? record.content_hash
  });
  await input.transactionJournal.put(next);
  return next;
}

async function ensureContentCommitted(
  input: ArtifactTransactionInput,
  record: ArtifactTransactionRecord,
  now: () => string
): Promise<ArtifactTransactionRecord> {
  if (stageIndex(record.stage) >= stageIndex("content_committed")) {
    return record;
  }
  if (record.pending_uri === undefined) {
    throw new ArtifactTransactionError(
      "artifact_transaction_invalid",
      `Artifact transaction ${record.transaction_id} cannot commit without pending content.`,
      { transaction_id: record.transaction_id }
    );
  }

  const committed = await input.contentStore.commit({
    transaction_id: record.transaction_id,
    run_id: record.run_id,
    node_id: record.node_id,
    artifact_id: record.artifact_id,
    artifact_path: record.artifact_path,
    pending_uri: record.pending_uri,
    content_hash: record.content_hash,
    overwrite_policy: record.overwrite_policy
  });
  const next = advance(record, "content_committed", now, {
    committed_uri: committed.uri,
    content_hash: committed.content_hash ?? record.content_hash
  });
  await input.transactionJournal.put(next);
  return next;
}

async function ensureManifestUpdated(
  input: ArtifactTransactionInput,
  record: ArtifactTransactionRecord,
  manifest: ArtifactManifest,
  now: () => string
): Promise<ArtifactTransactionRecord> {
  if (stageIndex(record.stage) >= stageIndex("manifest_updated")) {
    return record;
  }
  await input.manifestStore.put(manifest);
  const next = advance(record, "manifest_updated", now);
  await input.transactionJournal.put(next);
  return next;
}

async function ensureStepsPublished(
  input: ArtifactTransactionInput,
  record: ArtifactTransactionRecord,
  manifest: ArtifactManifest,
  now: () => string
): Promise<ArtifactTransactionRecord> {
  if (stageIndex(record.stage) >= stageIndex("steps_published")) {
    return record;
  }
  await input.stepsPublisher.publishArtifactRef(manifest);
  const next = advance(record, "steps_published", now);
  await input.transactionJournal.put(next);
  return next;
}

async function ensureCheckpointMarked(
  input: ArtifactTransactionInput,
  record: ArtifactTransactionRecord,
  manifest: ArtifactManifest,
  now: () => string
): Promise<ArtifactTransactionRecord> {
  if (stageIndex(record.stage) >= stageIndex("checkpoint_marked")) {
    return record;
  }
  await input.checkpointMarker.markArtifactCheckpointed(manifest);
  const next = advance(record, "checkpoint_marked", now);
  await input.transactionJournal.put(next);
  return next;
}

function manifestFromRecord(record: ArtifactTransactionRecord): ArtifactManifest {
  if (record.committed_uri === undefined) {
    throw new ArtifactTransactionError(
      "artifact_transaction_invalid",
      `Artifact transaction ${record.transaction_id} has no committed URI.`,
      { transaction_id: record.transaction_id }
    );
  }

  return {
    id: record.artifact_id,
    run_id: record.run_id,
    uri: record.committed_uri,
    backend_id: record.backend_id,
    backend_root: record.backend_root,
    source_node_id: record.node_id,
    ...(record.media_type === undefined ? {} : { media_type: record.media_type }),
    ...(record.semantic_type === undefined
      ? {}
      : { semantic_type: record.semantic_type }),
    content_hash: record.content_hash,
    ...(record.content_size_bytes === undefined
      ? {}
      : { content_size_bytes: record.content_size_bytes }),
    artifact_path: record.artifact_path,
    status: "committed",
    attempt: record.attempt,
    created_at: record.created_at
  };
}

function pendingManifestFromRecord(
  record: ArtifactTransactionRecord
): ArtifactManifest {
  const pendingKey = pendingManifestKeySuffix(record.transaction_id);

  return {
    id: `${record.artifact_id}:pending:${pendingKey}`,
    run_id: record.run_id,
    uri: `pending://${record.transaction_id}`,
    backend_id: record.backend_id,
    backend_root: record.backend_root,
    source_node_id: record.node_id,
    ...(record.media_type === undefined ? {} : { media_type: record.media_type }),
    ...(record.semantic_type === undefined
      ? {}
      : { semantic_type: record.semantic_type }),
    content_hash: record.content_hash,
    ...(record.content_size_bytes === undefined
      ? {}
      : { content_size_bytes: record.content_size_bytes }),
    artifact_path: `.pending-artifact-transactions/${pendingKey}.json`,
    status: "pending",
    attempt: record.attempt,
    created_at: record.created_at
  };
}

function pendingManifestKeySuffix(transactionId: string): string {
  return hashArtifactContent(transactionId).slice("sha256:".length);
}

function checkpointedRecordFromManifest({
  input,
  manifest,
  contentHash,
  contentSizeBytes,
  overwritePolicy,
  transactionId,
  now
}: {
  input: ArtifactTransactionInput;
  manifest: ArtifactManifest;
  contentHash: string;
  contentSizeBytes: number;
  overwritePolicy: ArtifactOverwritePolicy;
  transactionId: string;
  now: string;
}): ArtifactTransactionRecord {
  return {
    transaction_id: transactionId,
    run_id: input.run_id,
    node_id: input.node_id,
    artifact_id: input.artifact_id,
    artifact_path: input.artifact_path,
    backend_id: input.backend.id,
    backend_root: input.backend.root,
    overwrite_policy: overwritePolicy,
    content_hash: contentHash,
    content_size_bytes: contentSizeBytes,
    attempt: input.attempt ?? 1,
    ...(input.media_type === undefined ? {} : { media_type: input.media_type }),
    ...(input.semantic_type === undefined
      ? {}
      : { semantic_type: input.semantic_type }),
    stage: "checkpoint_marked",
    committed_uri: manifest.uri,
    created_at: manifest.created_at,
    updated_at: now
  };
}

function adoptCommittedManifest({
  input,
  manifest,
  contentHash,
  contentSizeBytes,
  overwritePolicy,
  transactionId,
  now
}: {
  input: ArtifactTransactionInput;
  manifest: ArtifactManifest | undefined;
  contentHash: string;
  contentSizeBytes: number;
  overwritePolicy: ArtifactOverwritePolicy;
  transactionId: string;
  now: string;
}): ArtifactTransactionRecord | undefined {
  if (
    !manifestMatchesTransactionInput(manifest, input) ||
    manifest?.status !== "committed" ||
    manifest.content_hash !== contentHash ||
    manifest.attempt !== (input.attempt ?? 1)
  ) {
    return undefined;
  }

  return {
    transaction_id: transactionId,
    run_id: input.run_id,
    node_id: input.node_id,
    artifact_id: input.artifact_id,
    artifact_path: input.artifact_path,
    backend_id: input.backend.id,
    backend_root: input.backend.root,
    overwrite_policy: overwritePolicy,
    content_hash: contentHash,
    content_size_bytes: contentSizeBytes,
    attempt: input.attempt ?? 1,
    ...(input.media_type === undefined ? {} : { media_type: input.media_type }),
    ...(input.semantic_type === undefined
      ? {}
      : { semantic_type: input.semantic_type }),
    stage: "manifest_updated",
    committed_uri: manifest.uri,
    created_at: manifest.created_at,
    updated_at: now
  };
}

function manifestMatchesTransactionIdentity(
  manifest: ArtifactManifest | undefined,
  input: ArtifactTransactionInput
): boolean {
  return (
    manifest !== undefined &&
    manifest.run_id === input.run_id &&
    manifest.source_node_id === input.node_id &&
    manifest.artifact_path === input.artifact_path &&
    manifest.attempt === (input.attempt ?? 1) &&
    manifest.backend_id === input.backend.id &&
    manifest.backend_root === input.backend.root
  );
}

function manifestMatchesTransactionInput(
  manifest: ArtifactManifest | undefined,
  input: ArtifactTransactionInput
): boolean {
  return (
    manifestMatchesTransactionIdentity(manifest, input) &&
    manifest?.semantic_type === input.semantic_type
  );
}

function manifestKeyFor(input: ArtifactTransactionInput): ArtifactManifestKey {
  return {
    id: input.artifact_id,
    run_id: input.run_id,
    source_node_id: input.node_id,
    artifact_path: input.artifact_path,
    attempt: input.attempt ?? 1,
    backend_id: input.backend.id,
    backend_root: input.backend.root
  };
}

function transactionIdFor(input: ArtifactTransactionInput): string {
  return `artifact-tx:${hashArtifactContent(
    JSON.stringify({
      run_id: input.run_id,
      node_id: input.node_id,
      attempt: input.attempt ?? 1,
      backend_id: input.backend.id,
      backend_root: input.backend.root,
      artifact_path: input.artifact_path,
      artifact_id: input.artifact_id
    })
  )}`;
}

function advance(
  record: ArtifactTransactionRecord,
  stage: ArtifactTransactionStage,
  now: () => string,
  patch: Partial<ArtifactTransactionRecord> = {}
): ArtifactTransactionRecord {
  return {
    ...record,
    ...patch,
    stage,
    updated_at: now()
  };
}

function stageIndex(stage: ArtifactTransactionStage): number {
  return STAGES.indexOf(stage);
}

const STAGES: readonly ArtifactTransactionStage[] = [
  "pending_manifest_created",
  "content_written",
  "content_committed",
  "manifest_updated",
  "steps_published",
  "checkpoint_marked"
];
