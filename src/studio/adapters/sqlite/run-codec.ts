import { canonicalJson, sha256Digest } from "../../../core/workflow/definition-digests.js";
import {
  RunEventSchema,
  RunRecordSchema,
  type RunEvent,
  type RunRecord
} from "../../contracts/runs.js";
import { runStoreError } from "../../application/runs/errors.js";

export type RunRow = {
  run_id: string;
  schema_version: number;
  record_revision: number;
  dispatch_status: string;
  run_status: string | null;
  heartbeat_at: string | null;
  heartbeat_at_ms: number | null;
  created_at: string;
  created_at_ms: number;
  updated_at: string;
  updated_at_ms: number;
  record_json: string;
};

export type RunEventRow = {
  run_id: string;
  sequence: number;
  event_id: string;
  event_type: string;
  occurred_at: string;
  occurred_at_ms: number;
  record_revision: number | null;
  data_json: string;
};

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw runStoreError("run_store_corrupt", "Run store contains invalid JSON");
  }
}

export function recordFromJson(value: string): RunRecord {
  const parsed = RunRecordSchema.safeParse(parseJson(value));
  if (!parsed.success) {
    throw runStoreError("run_store_corrupt", "Run store contains an invalid run record");
  }
  return parsed.data;
}

export function recordFromRow(row: RunRow): RunRecord {
  const record = recordFromJson(row.record_json);
  if (record.run_id !== row.run_id || record.schema_version !== row.schema_version ||
    record.record_revision !== row.record_revision ||
    record.dispatch_status !== row.dispatch_status ||
    (record.run_status ?? null) !== row.run_status ||
    (record.heartbeat_at ?? null) !== row.heartbeat_at ||
    (record.heartbeat_at === undefined ? null : Date.parse(record.heartbeat_at)) !==
      row.heartbeat_at_ms ||
    record.created_at !== row.created_at || Date.parse(record.created_at) !== row.created_at_ms ||
    record.updated_at !== row.updated_at || Date.parse(record.updated_at) !== row.updated_at_ms) {
    throw runStoreError("run_store_corrupt", "Run record projection is inconsistent");
  }
  return record;
}

export function eventFromRow(row: RunEventRow): RunEvent {
  if (Date.parse(row.occurred_at) !== row.occurred_at_ms) {
    throw runStoreError("run_store_corrupt", "Run event timestamp projection is inconsistent");
  }
  const parsed = RunEventSchema.safeParse({
    schema_version: 1,
    run_id: row.run_id,
    sequence: row.sequence,
    event_id: row.event_id,
    event_type: row.event_type,
    occurred_at: row.occurred_at,
    ...(row.record_revision === null ? {} : { record_revision: row.record_revision }),
    data: parseJson(row.data_json)
  });
  if (!parsed.success) {
    throw runStoreError("run_store_corrupt", "Run store contains an invalid event");
  }
  return parsed.data;
}

export function recordJson(record: RunRecord): string {
  return canonicalJson(RunRecordSchema.parse(record));
}

export function commandHash(value: unknown): string {
  return sha256Digest(value);
}

export function boundedCanonicalJson(
  value: unknown,
  maxBytes: number,
  label: "run record" | "run event"
): string {
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    throw runStoreError("run_invalid_input", `${label} exceeds its storage limit`);
  }
  return json;
}

export function assertSafePersistedInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw runStoreError("run_store_corrupt", `Persisted ${label} is outside the safe range`);
  }
  return value;
}
