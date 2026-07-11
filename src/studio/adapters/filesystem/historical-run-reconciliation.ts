import { createHash } from "node:crypto";
import type { HistoricalRunMetadataOptions } from "./historical-run-metadata.js";
import { RunRecordSchema, type RunRecord } from "../../contracts/runs.js";
import type { HistoricalRunMetadata } from "./historical-run-metadata.js";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_ROOT_ENTRIES = 5_000;
const DEFAULT_MAX_RUN_DIRECTORIES = 1_000;
const DEFAULT_SUMMARY_MAX_BYTES = 65_536;
const DEFAULT_TRACE_FIRST_LINE_MAX_BYTES = 131_072;
const DEFAULT_TRACKED_RUN_LIMIT = 10_000;
const DEFAULT_PENDING_RUN_LIMIT = 1_000;
const DEFAULT_PENDING_RETRY_BATCH_SIZE = 100;
const DEFAULT_PENDING_RETRY_BASE_MS = 1_000;

export type HistoricalRunReconciliationOptions = {
  readonly intervalMs?: number;
  readonly maxRootEntries?: number;
  readonly maxRunDirectories?: number;
  readonly summaryMaxBytes?: number;
  readonly traceFirstLineMaxBytes?: number;
  readonly trackedRunLimit?: number;
  readonly pendingRunLimit?: number;
  readonly pendingRetryBatchSize?: number;
  readonly pendingRetryBaseMs?: number;
};

export type HistoricalRunReconciliationReport = {
  readonly examinedEntries: number;
  readonly examinedRunDirectories: number;
  readonly imported: number;
  readonly alreadyKnown: number;
  readonly skipped: number;
};

export type MutableHistoricalRunReconciliationReport = {
  -readonly [Key in keyof HistoricalRunReconciliationReport]:
    HistoricalRunReconciliationReport[Key];
};

export type ResolvedHistoricalRunReconciliationOptions =
  HistoricalRunMetadataOptions & {
    readonly intervalMs: number;
    readonly maxRootEntries: number;
    readonly maxRunDirectories: number;
    readonly trackedRunLimit: number;
    readonly pendingRunLimit: number;
    readonly pendingRetryBatchSize: number;
    readonly pendingRetryBaseMs: number;
  };

export function emptyHistoricalRunReconciliationReport():
  HistoricalRunReconciliationReport {
  return {
    examinedEntries: 0,
    examinedRunDirectories: 0,
    imported: 0,
    alreadyKnown: 0,
    skipped: 0
  };
}

function boundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function resolveHistoricalRunReconciliationOptions(
  options: HistoricalRunReconciliationOptions
): ResolvedHistoricalRunReconciliationOptions {
  const maxRootEntries = boundedInteger(
    options.maxRootEntries ?? DEFAULT_MAX_ROOT_ENTRIES,
    "Historical run root entry limit",
    1,
    100_000
  );
  const maxRunDirectories = boundedInteger(
    options.maxRunDirectories ?? DEFAULT_MAX_RUN_DIRECTORIES,
    "Historical run directory limit",
    1,
    maxRootEntries
  );
  return {
    intervalMs: boundedInteger(
      options.intervalMs ?? DEFAULT_INTERVAL_MS,
      "Historical run reconciliation interval",
      10,
      3_600_000
    ),
    maxRootEntries,
    maxRunDirectories,
    summaryMaxBytes: boundedInteger(
      options.summaryMaxBytes ?? DEFAULT_SUMMARY_MAX_BYTES,
      "Historical run summary byte limit",
      64,
      1_048_576
    ),
    traceFirstLineMaxBytes: boundedInteger(
      options.traceFirstLineMaxBytes ?? DEFAULT_TRACE_FIRST_LINE_MAX_BYTES,
      "Historical run trace line byte limit",
      64,
      1_048_576
    ),
    trackedRunLimit: boundedInteger(
      options.trackedRunLimit ?? DEFAULT_TRACKED_RUN_LIMIT,
      "Historical run tracking limit",
      1,
      100_000
    ),
    pendingRunLimit: boundedInteger(
      options.pendingRunLimit ?? DEFAULT_PENDING_RUN_LIMIT,
      "Historical pending run limit",
      1,
      100_000
    ),
    pendingRetryBatchSize: boundedInteger(
      options.pendingRetryBatchSize ?? DEFAULT_PENDING_RETRY_BATCH_SIZE,
      "Historical pending retry batch size",
      1,
      10_000
    ),
    pendingRetryBaseMs: boundedInteger(
      options.pendingRetryBaseMs ?? DEFAULT_PENDING_RETRY_BASE_MS,
      "Historical pending retry delay",
      10,
      3_600_000
    )
  };
}

export function historicalRunRecord(metadata: HistoricalRunMetadata): RunRecord {
  return RunRecordSchema.parse({
    schema_version: 1,
    record_revision: 1,
    run_id: metadata.runId,
    workflow_id: metadata.workflowId,
    ...(metadata.workflowRevision === undefined
      ? {}
      : { workflow_revision: metadata.workflowRevision }),
    dispatch_status: "historical_unknown",
    created_at: metadata.createdAt,
    updated_at: metadata.createdAt,
    source: "artifact-filesystem",
    active_node_ids: [],
    side_effects: [],
    lifecycle_projection: "unknown",
    completeness: "legacy"
  });
}

export function historicalRunImportIds(record: RunRecord): {
  readonly transitionId: string;
  readonly eventId: string;
} {
  const digest = createHash("sha256")
    .update(JSON.stringify(record), "utf8")
    .digest("hex");
  return {
    transitionId: `historical-import-${digest}`,
    eventId: `historical-event-${digest}`
  };
}
