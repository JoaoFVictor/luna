import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { runDisplayStatus } from "../../application/runs/lifecycle.js";
import { runStoreError } from "../../application/runs/errors.js";
import {
  recordFromJson,
  recordFromRow,
  recordJson,
  type RunRow
} from "./run-codec.js";
import {
  runStatement,
  withImmediateTransaction,
  withReadTransaction
} from "./run-database.js";

type OutboxRow = {
  outbox_id: number;
  run_id: string;
  record_revision: number;
  record_json: string;
};

export type RunCatalogMetadata = {
  cursor_secret: string;
  catalog_generation: string;
  catalog_epoch: number;
};

export function readCatalogMetadata(database: DatabaseSync): RunCatalogMetadata {
  const row = runStatement(database, `
    SELECT cursor_secret, catalog_generation, catalog_epoch
    FROM studio_run_metadata WHERE singleton = 1
  `).get() as RunCatalogMetadata | undefined;
  if (row === undefined || !Number.isSafeInteger(row.catalog_epoch) ||
    row.catalog_epoch < 0 || !/^[a-f0-9]{64}$/.test(row.cursor_secret) ||
    !/^[A-Za-z0-9_-]{24}$/.test(row.catalog_generation)) {
    throw runStoreError("run_store_corrupt", "Run catalog metadata is unavailable");
  }
  return row;
}

function insertCatalogVersion(
  database: DatabaseSync,
  recordValue: string,
  epoch: number,
  projectedAtMs: number
): void {
  const record = recordFromJson(recordValue);
  runStatement(database, `
    UPDATE studio_run_catalog_versions
    SET valid_to_epoch = ?, valid_to_at_ms = ?
    WHERE run_id = ? AND valid_to_epoch IS NULL
  `).run(epoch, projectedAtMs, record.run_id);
  runStatement(database, `
    INSERT INTO studio_run_catalog_versions (
      run_id, valid_from_epoch, valid_to_epoch, valid_to_at_ms, workflow_id, status,
      source, correlation_id, job_id, created_at, created_at_ms, projected_at_ms,
      record_json
    ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.run_id,
    epoch,
    record.workflow_id,
    runDisplayStatus(record),
    record.source ?? null,
    record.correlation_id ?? null,
    record.job_id ?? null,
    record.created_at,
    Date.parse(record.created_at),
    projectedAtMs,
    recordJson(record)
  );
}

export function projectPendingRunCatalog(
  database: DatabaseSync,
  requestedLimit = 500,
  projectedAtMs = Date.now()
): number {
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 10_000) {
    throw runStoreError("run_invalid_input", "Projection limit must be between 1 and 10000");
  }
  if (!Number.isSafeInteger(projectedAtMs) || projectedAtMs < 0) {
    throw runStoreError("run_invalid_input", "Projection time is invalid");
  }
  const pending = withReadTransaction(database, () =>
    runStatement(database, `
      SELECT EXISTS(SELECT 1 FROM studio_run_outbox LIMIT 1) AS pending
    `).get() as { pending: number });
  if (pending.pending !== 1) {
    return 0;
  }
  return withImmediateTransaction(database, () => {
    const rows = runStatement(database, `
      SELECT outbox_id, run_id, record_revision, record_json
      FROM studio_run_outbox
      ORDER BY outbox_id ASC
      LIMIT ?
    `).all(requestedLimit) as OutboxRow[];
    if (rows.length === 0) {
      return 0;
    }

    let epoch = readCatalogMetadata(database).catalog_epoch;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.outbox_id) || !Number.isSafeInteger(row.record_revision)) {
        throw runStoreError("run_store_corrupt", "Run outbox contains an invalid sequence");
      }
      const record = recordFromJson(row.record_json);
      if (record.run_id !== row.run_id || record.record_revision !== row.record_revision) {
        throw runStoreError("run_store_corrupt", "Run outbox projection is inconsistent");
      }
      epoch += 1;
      if (!Number.isSafeInteger(epoch)) {
        throw runStoreError("run_store_corrupt", "Run catalog epoch is exhausted");
      }
      insertCatalogVersion(database, row.record_json, epoch, projectedAtMs);
      runStatement(database, "DELETE FROM studio_run_outbox WHERE outbox_id = ?")
        .run(row.outbox_id);
    }
    runStatement(database, `
      UPDATE studio_run_metadata SET catalog_epoch = ? WHERE singleton = 1
    `).run(epoch);
    return rows.length;
  });
}

export function rebuildRunCatalog(database: DatabaseSync, projectedAtMs = Date.now()): number {
  if (!Number.isSafeInteger(projectedAtMs) || projectedAtMs < 0) {
    throw runStoreError("run_invalid_input", "Projection time is invalid");
  }
  return withImmediateTransaction(database, () => {
    const rows = runStatement(database, `
      SELECT run_id, schema_version, record_revision, dispatch_status, run_status,
        heartbeat_at, heartbeat_at_ms, created_at, created_at_ms,
        updated_at, updated_at_ms, record_json
      FROM studio_runs
      ORDER BY created_at ASC, run_id ASC
    `).all() as RunRow[];
    database.exec("DELETE FROM studio_run_catalog_versions");
    database.exec("DELETE FROM studio_run_outbox");

    let epoch = 0;
    for (const row of rows) {
      epoch += 1;
      insertCatalogVersion(database, recordJson(recordFromRow(row)), epoch, projectedAtMs);
    }
    runStatement(database, `
      UPDATE studio_run_metadata
      SET catalog_epoch = ?, catalog_generation = ?
      WHERE singleton = 1
    `).run(epoch, randomBytes(18).toString("base64url"));
    return rows.length;
  });
}

export function pruneRunCatalogHistory(
  database: DatabaseSync,
  closedBeforeMs: number
): number {
  if (!Number.isSafeInteger(closedBeforeMs)) {
    throw runStoreError("run_invalid_input", "Catalog retention time is invalid");
  }
  return withImmediateTransaction(database, () => {
    const result = runStatement(database, `
      DELETE FROM studio_run_catalog_versions
      WHERE valid_to_at_ms IS NOT NULL AND valid_to_at_ms < ?
    `).run(closedBeforeMs);
    return Number(result.changes);
  });
}
