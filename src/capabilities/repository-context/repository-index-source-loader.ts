import { openFileBeneath } from "../../core/security/secure-root-file.js";
import {
  candidateOutcomeFromCapturedBytes,
  classifyCandidateBytes,
  readCandidateOutcome,
  type CandidateReadOutcome
} from "./candidate-reader.js";
import type { Candidate } from "./file-analysis.js";
import { estimateRetainedBytes } from "./retained-size-estimator.js";
import { gitBlobSizes, readGitBlobPrefix, readGitBlobs } from "./repository-index-blobs.js";
import type {
  RepositoryContentSource,
  RepositorySnapshotIdentity
} from "./repository-index-inventory.js";
import {
  repositoryIndexCapacityError,
  REPOSITORY_INDEX_RESOURCE_POLICY,
  RepositoryIndexSnapshotChangedError
} from "./repository-index-policy.js";

const METADATA_CONCURRENCY = 32;
const CLASSIFICATION_PREFIX_BYTES = 64 * 1024;

type PlannedFile = {
  readonly path: string;
  readonly bytes: number;
  readonly source: RepositoryContentSource;
};

type PreflightResult = {
  readonly files: readonly PlannedFile[];
  readonly unavailable: readonly string[];
  readonly binaryExcluded: readonly string[];
  readonly sensitiveExcluded: readonly string[];
  readonly sourceBytes: number;
  readonly durationMs: number;
};

export type LoadedRepositoryCandidates = {
  readonly candidates: readonly Candidate[];
  readonly unavailable: readonly string[];
  readonly binaryExcluded: readonly string[];
  readonly sensitiveExcluded: readonly string[];
  readonly indexedSourceBytes: number;
  readonly plannedSourceBytes: number;
  readonly peakInflightBytes: number;
  readonly concurrency: number;
  readonly preflightDurationMs: number;
};

async function preflightFiles(
  root: string,
  files: readonly string[],
  sources: ReadonlyMap<string, RepositoryContentSource>,
  signal?: AbortSignal
): Promise<PreflightResult> {
  const started = Date.now();
  const plans: Array<PlannedFile | undefined> = new Array(files.length);
  const unavailable: string[] = [];
  const binaryExcluded: string[] = [];
  const sensitiveExcluded: string[] = [];
  let nextIndex = 0;
  let sourceBytes = 0;
  let failure: unknown;
  function reserveSource(bytes: number): void {
    sourceBytes += bytes;
    if (sourceBytes > REPOSITORY_INDEX_RESOURCE_POLICY.max_total_source_bytes) {
      throw repositoryIndexCapacityError({
        phase: "preflight",
        resource: "total_source_bytes",
        observed: sourceBytes,
        limit: REPOSITORY_INDEX_RESOURCE_POLICY.max_total_source_bytes
      });
    }
  }
  const blobRequests = files.flatMap((file) => {
    const source = sources.get(file);
    return source?.kind === "git_blob" ? [{ path: file, oid: source.oid }] : [];
  });
  const blobSizes = await gitBlobSizes(
    root,
    blobRequests,
    REPOSITORY_INDEX_RESOURCE_POLICY.max_git_metadata_bytes,
    signal
  );

  async function worker(): Promise<void> {
    while (failure === undefined && nextIndex < files.length) {
      signal?.throwIfAborted();
      const index = nextIndex++;
      const file = files[index] as string;
      try {
        const source = sources.get(file);
        if (source === undefined) {
          throw new RepositoryIndexSnapshotChangedError(file);
        }
        if (source.kind === "git_blob") {
          const bytes = blobSizes.get(file);
          if (bytes === undefined) {
            throw new RepositoryIndexSnapshotChangedError(file);
          }
          if (bytes > REPOSITORY_INDEX_RESOURCE_POLICY.max_file_source_bytes) {
            const classification = classifyCandidateBytes(await readGitBlobPrefix(
              root,
              { path: file, oid: source.oid },
              CLASSIFICATION_PREFIX_BYTES,
              signal
            ), { prefix: true });
            if (classification === "binary") {
              binaryExcluded.push(file);
              continue;
            }
            if (classification === "sensitive") {
              sensitiveExcluded.push(file);
              continue;
            }
          }
          reserveFileSource(bytes, file);
          reserveSource(bytes);
          plans[index] = { path: file, bytes, source };
          continue;
        }
        const handle = await openFileBeneath(root, file);
        const stat = handle === undefined
          ? undefined
          : await handle.stat({ bigint: true }).finally(async () => {
              await handle.close().catch(() => undefined);
            });
        if (
          stat === undefined ||
          !stat.isFile() ||
          stat.size < 0n ||
          stat.size > BigInt(Number.MAX_SAFE_INTEGER)
        ) {
          unavailable.push(file);
          continue;
        }
        const bytes = Number(stat.size);
        if (bytes > REPOSITORY_INDEX_RESOURCE_POLICY.max_file_source_bytes) {
          const handle = await openFileBeneath(root, file);
          if (handle === undefined) {
            unavailable.push(file);
            continue;
          }
          const prefix = Buffer.alloc(Math.min(bytes, CLASSIFICATION_PREFIX_BYTES));
          const read = await handle.read(prefix, 0, prefix.length, 0)
            .finally(async () => await handle.close().catch(() => undefined));
          const classification = classifyCandidateBytes(
            prefix.subarray(0, read.bytesRead),
            { prefix: true }
          );
          if (classification === "binary") {
            binaryExcluded.push(file);
            continue;
          }
          if (classification === "sensitive") {
            sensitiveExcluded.push(file);
            continue;
          }
        }
        reserveFileSource(bytes, file);
        reserveSource(bytes);
        plans[index] = { path: file, bytes, source };
      } catch (cause) {
        failure ??= cause;
      }
    }
  }

  await Promise.all(Array.from({
    length: Math.min(METADATA_CONCURRENCY, files.length)
  }, () => worker()));
  if (failure !== undefined) {
    throw failure;
  }
  return {
    files: plans.filter((plan): plan is PlannedFile => plan !== undefined),
    unavailable: unavailable.sort(),
    binaryExcluded: binaryExcluded.sort(),
    sensitiveExcluded: sensitiveExcluded.sort(),
    sourceBytes,
    durationMs: Date.now() - started
  };
}

function reserveFileSource(bytes: number, file: string): void {
  if (bytes > REPOSITORY_INDEX_RESOURCE_POLICY.max_file_source_bytes) {
    throw repositoryIndexCapacityError({
      phase: "preflight",
      resource: "file_source_bytes",
      observed: bytes,
      limit: REPOSITORY_INDEX_RESOURCE_POLICY.max_file_source_bytes,
      path: file
    });
  }
}

async function readCandidates(
  root: string,
  plans: readonly PlannedFile[],
  signal?: AbortSignal
): Promise<Omit<LoadedRepositoryCandidates, "plannedSourceBytes" | "preflightDurationMs">> {
  const candidates: Array<Candidate | undefined> = new Array(plans.length);
  const unavailable: string[] = [];
  const binaryExcluded: string[] = [];
  const sensitiveExcluded: string[] = [];
  const largest = plans.reduce((maximum, plan) => Math.max(maximum, plan.bytes), 0);
  const concurrency = plans.length === 0
    ? 0
    : Math.min(
        REPOSITORY_INDEX_RESOURCE_POLICY.max_read_concurrency,
        plans.length,
        Math.max(1, Math.floor(
          REPOSITORY_INDEX_RESOURCE_POLICY.max_inflight_source_bytes / Math.max(1, largest)
        ))
      );
  let nextIndex = 0;
  let activeBytes = 0;
  let peakInflightBytes = 0;
  let indexedSourceBytes = 0;
  let retainedBytes = 0;
  let failure: unknown;

  function accept(index: number, plan: PlannedFile, outcome: CandidateReadOutcome): void {
    if (outcome.kind === "unavailable") {
      unavailable.push(plan.path);
      return;
    }
    if (outcome.kind === "binary") {
      binaryExcluded.push(plan.path);
      return;
    }
    if (outcome.kind === "sensitive") {
      sensitiveExcluded.push(plan.path);
      return;
    }
    const candidate = outcome.candidate;
    if (candidate.truncated) {
      throw repositoryIndexCapacityError({
        phase: "read",
        resource: "file_source_bytes",
        observed: REPOSITORY_INDEX_RESOURCE_POLICY.max_file_source_bytes + 1,
        limit: REPOSITORY_INDEX_RESOURCE_POLICY.max_file_source_bytes,
        path: plan.path
      });
    }
    if (plan.source.kind === "worktree" && candidate.content_digest !== plan.source.fingerprint) {
      throw new RepositoryIndexSnapshotChangedError(plan.path);
    }
    retainedBytes += estimateRetainedBytes(candidate);
    if (retainedBytes > REPOSITORY_INDEX_RESOURCE_POLICY.max_retained_index_bytes) {
      throw repositoryIndexCapacityError({
        phase: "read",
        resource: "retained_index_bytes",
        observed: retainedBytes,
        limit: REPOSITORY_INDEX_RESOURCE_POLICY.max_retained_index_bytes,
        path: plan.path
      });
    }
    indexedSourceBytes += plan.bytes;
    candidates[index] = candidate;
  }

  async function worker(): Promise<void> {
    while (failure === undefined && nextIndex < plans.length) {
      signal?.throwIfAborted();
      const index = nextIndex++;
      const plan = plans[index] as PlannedFile;
      if (plan.source.kind === "git_blob") {
        continue;
      }
      activeBytes += plan.bytes;
      peakInflightBytes = Math.max(peakInflightBytes, activeBytes);
      try {
        accept(index, plan, await readCandidateOutcome(
          root,
          plan.path,
          REPOSITORY_INDEX_RESOURCE_POLICY.max_file_source_bytes,
          signal
        ));
      } catch (cause) {
        failure ??= cause;
      } finally {
        activeBytes -= plan.bytes;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (failure !== undefined) {
    throw failure;
  }
  const blobPlans = plans.map((plan, index) => ({ plan, index }))
    .filter((entry) => entry.plan.source.kind === "git_blob");
  let batch: typeof blobPlans = [];
  let batchBytes = 0;
  async function flushBlobBatch(): Promise<void> {
    if (batch.length === 0) {
      return;
    }
    signal?.throwIfAborted();
    const blobs = await readGitBlobs(
      root,
      batch.map(({ plan }) => ({
        path: plan.path,
        oid: (plan.source as Extract<RepositoryContentSource, { kind: "git_blob" }>).oid
      })),
      batchBytes,
      signal
    );
    peakInflightBytes = Math.max(peakInflightBytes, batchBytes);
    for (const { plan, index } of batch) {
      accept(index, plan, candidateOutcomeFromCapturedBytes(
        root,
        plan.path,
        blobs.get(plan.path) as Buffer,
        REPOSITORY_INDEX_RESOURCE_POLICY.max_file_source_bytes
      ));
    }
    batch = [];
    batchBytes = 0;
  }
  for (const entry of blobPlans) {
    if (batch.length > 0 && batchBytes + entry.plan.bytes >
      REPOSITORY_INDEX_RESOURCE_POLICY.max_inflight_source_bytes) {
      await flushBlobBatch();
    }
    batch.push(entry);
    batchBytes += entry.plan.bytes;
  }
  await flushBlobBatch();
  return {
    candidates: candidates.filter((candidate): candidate is Candidate => candidate !== undefined),
    unavailable: unavailable.sort(),
    binaryExcluded: binaryExcluded.sort(),
    sensitiveExcluded: sensitiveExcluded.sort(),
    indexedSourceBytes,
    peakInflightBytes,
    concurrency: Math.max(concurrency, blobPlans.length === 0 ? 0 : 1)
  };
}

export async function loadRepositoryCandidates(
  root: string,
  identity: RepositorySnapshotIdentity,
  signal?: AbortSignal
): Promise<LoadedRepositoryCandidates> {
  const preflight = await preflightFiles(root, identity.eligible, identity.contentSources, signal);
  const read = await readCandidates(root, preflight.files, signal);
  return {
    ...read,
    unavailable: [...preflight.unavailable, ...read.unavailable].sort(),
    binaryExcluded: [...preflight.binaryExcluded, ...read.binaryExcluded].sort(),
    sensitiveExcluded: [...preflight.sensitiveExcluded, ...read.sensitiveExcluded].sort(),
    plannedSourceBytes: preflight.sourceBytes,
    preflightDurationMs: preflight.durationMs
  };
}
