import type { DatabaseSync } from "node:sqlite";
import { runStoreError } from "../../application/runs/errors.js";
import type { RunEvent, RunRecord } from "../../contracts/runs.js";
import {
  boundedCanonicalJson,
  recordFromRow,
  type RunRow
} from "./run-codec.js";
import { projectPendingRunCatalog } from "./run-catalog-projector.js";
import { runStatement } from "./run-database.js";
import {
  hasPendingProjection,
  runStoreNow,
  type SqliteRunStoreContext
} from "./run-store-context.js";

export type TransitionRow = {
  command_hash: string;
  result_revision: number;
};

export function selectRun(database: DatabaseSync, runId: string): RunRecord | undefined {
  const row = runStatement(database, `
    SELECT run_id, schema_version, record_revision, dispatch_status, run_status,
      heartbeat_at, heartbeat_at_ms, created_at, created_at_ms,
      updated_at, updated_at_ms, record_json
    FROM studio_runs WHERE run_id = ?
  `).get(runId) as RunRow | undefined;
  return row === undefined ? undefined : recordFromRow(row);
}

export function selectTransition(
  database: DatabaseSync,
  runId: string,
  transitionId: string
): TransitionRow | undefined {
  const row = runStatement(database, `
    SELECT command_hash, result_revision
    FROM studio_run_transitions
    WHERE run_id = ? AND transition_id = ?
  `).get(runId, transitionId) as TransitionRow | undefined;
  if (row !== undefined &&
    (!/^sha256:[a-f0-9]{64}$/.test(row.command_hash) ||
      !Number.isSafeInteger(row.result_revision) || row.result_revision < 1)) {
    throw runStoreError("run_store_corrupt", "Run transition record is invalid");
  }
  return row;
}

export function assertEventIdAvailable(
  database: DatabaseSync,
  runId: string,
  eventId: string
): void {
  const existing = runStatement(database, `
    SELECT 1 AS present FROM studio_run_events WHERE run_id = ? AND event_id = ?
  `).get(runId, eventId);
  if (existing !== undefined) {
    throw runStoreError("run_event_id_conflict", "Run event id is already in use", {
      run_id: runId
    });
  }
}

export function insertRun(
  database: DatabaseSync,
  record: RunRecord,
  payload: string
): void {
  runStatement(database, `
    INSERT INTO studio_runs (
      run_id, schema_version, record_revision, dispatch_status, run_status,
      heartbeat_at, heartbeat_at_ms, created_at, created_at_ms,
      updated_at, updated_at_ms, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.run_id,
    record.schema_version,
    record.record_revision,
    record.dispatch_status,
    record.run_status ?? null,
    record.heartbeat_at ?? null,
    record.heartbeat_at === undefined ? null : Date.parse(record.heartbeat_at),
    record.created_at,
    Date.parse(record.created_at),
    record.updated_at,
    Date.parse(record.updated_at),
    payload
  );
}

export function updateRun(
  database: DatabaseSync,
  record: RunRecord,
  expectedRevision: number,
  payload: string
): void {
  const result = runStatement(database, `
    UPDATE studio_runs
    SET record_revision = ?, dispatch_status = ?, run_status = ?, heartbeat_at = ?,
      heartbeat_at_ms = ?, updated_at = ?, updated_at_ms = ?, record_json = ?
    WHERE run_id = ? AND record_revision = ?
  `).run(
    record.record_revision,
    record.dispatch_status,
    record.run_status ?? null,
    record.heartbeat_at ?? null,
    record.heartbeat_at === undefined ? null : Date.parse(record.heartbeat_at),
    record.updated_at,
    Date.parse(record.updated_at),
    payload,
    record.run_id,
    expectedRevision
  );
  if (Number(result.changes) !== 1) {
    throw runStoreError("run_revision_conflict", "Run changed before transition commit", {
      run_id: record.run_id,
      expected_revision: expectedRevision
    });
  }
}

export function insertTransition(
  database: DatabaseSync,
  input: {
    runId: string;
    transitionId: string;
    commandHash: string;
    resultRevision: number;
    kind: string;
    occurredAt: string;
  }
): void {
  runStatement(database, `
    INSERT INTO studio_run_transitions (
      run_id, transition_id, command_hash, result_revision, transition_kind, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.runId,
    input.transitionId,
    input.commandHash,
    input.resultRevision,
    input.kind,
    input.occurredAt
  );
}

function insertEvent(
  database: DatabaseSync,
  event: RunEvent,
  eventCommandHash: string,
  maxEventBytes: number
): void {
  const dataJson = boundedCanonicalJson(event.data, maxEventBytes, "run event");
  runStatement(database, `
    INSERT INTO studio_run_events (
      run_id, sequence, event_id, command_hash, event_type, occurred_at,
      occurred_at_ms, record_revision, data_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.run_id,
    event.sequence,
    event.event_id,
    eventCommandHash,
    event.event_type,
    event.occurred_at,
    Date.parse(event.occurred_at),
    event.record_revision ?? null,
    dataJson
  );
}

export function insertFirstEvent(
  database: DatabaseSync,
  event: RunEvent,
  eventCommandHash: string,
  maxEventBytes: number
): void {
  runStatement(database, `
    INSERT INTO studio_run_event_heads (run_id, last_sequence) VALUES (?, 1)
  `).run(event.run_id);
  insertEvent(database, event, eventCommandHash, maxEventBytes);
}

export function appendTransitionEvent(
  database: DatabaseSync,
  input: {
    runId: string;
    eventId: string;
    eventType: string;
    occurredAt: string;
    recordRevision: number;
    commandHash: string;
    data: RunEvent["data"];
    maxEventBytes: number;
  }
): void {
  const head = runStatement(database, `
    SELECT last_sequence FROM studio_run_event_heads WHERE run_id = ?
  `).get(input.runId) as { last_sequence: number } | undefined;
  if (head === undefined || !Number.isSafeInteger(head.last_sequence) ||
    head.last_sequence < 1) {
    throw runStoreError("run_store_corrupt", "Run event head is unavailable");
  }
  const sequence = head.last_sequence + 1;
  if (!Number.isSafeInteger(sequence)) {
    throw runStoreError("run_store_corrupt", "Run event sequence is exhausted");
  }
  const previous = runStatement(database, `
    SELECT sequence, occurred_at, occurred_at_ms FROM studio_run_events
    WHERE run_id = ?
    ORDER BY sequence DESC
    LIMIT 1
  `).get(input.runId) as {
    sequence: number;
    occurred_at: string;
    occurred_at_ms: number;
  } | undefined;
  if (previous === undefined || previous.sequence !== head.last_sequence ||
    Date.parse(previous.occurred_at) !== previous.occurred_at_ms) {
    throw runStoreError("run_store_corrupt", "Run event sequence projection is invalid");
  }
  if (Date.parse(input.occurredAt) < previous.occurred_at_ms) {
    throw runStoreError(
      "run_transition_invalid",
      "Transition event time cannot precede the previous event",
      { run_id: input.runId }
    );
  }
  const updated = runStatement(database, `
    UPDATE studio_run_event_heads SET last_sequence = ?
    WHERE run_id = ? AND last_sequence = ?
  `).run(sequence, input.runId, head.last_sequence);
  if (Number(updated.changes) !== 1) {
    throw runStoreError(
      "run_event_sequence_conflict",
      "Run event sequence changed before transition append",
      { run_id: input.runId }
    );
  }
  insertEvent(database, {
    schema_version: 1,
    run_id: input.runId,
    sequence,
    event_id: input.eventId,
    event_type: input.eventType,
    occurred_at: input.occurredAt,
    record_revision: input.recordRevision,
    data: input.data
  }, input.commandHash, input.maxEventBytes);
}

export function insertOutbox(
  database: DatabaseSync,
  record: RunRecord,
  payload: string
): void {
  runStatement(database, `
    INSERT INTO studio_run_outbox (
      run_id, record_revision, record_json, created_at
    ) VALUES (?, ?, ?, ?)
  `).run(record.run_id, record.record_revision, payload, record.updated_at);
}

export function projectionPendingAfterBestEffort(
  context: SqliteRunStoreContext
): boolean {
  try {
    projectPendingRunCatalog(
      context.database,
      context.projectionBatchSize,
      Date.parse(runStoreNow(context))
    );
    return hasPendingProjection(context);
  } catch {
    return true;
  }
}
