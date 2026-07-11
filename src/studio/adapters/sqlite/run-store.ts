import type {
  RunCatalogPort,
  RunCatalogProjectorPort,
  RunEventLedgerPort,
  RunLedgerPort,
  RunReconcilerPort
} from "../../application/runs/ports.js";
import { runStoreError } from "../../application/runs/errors.js";
import { SqliteRunCatalog } from "./run-catalog.js";
import {
  closeSqliteRunDatabase,
  openSqliteRunDatabase
} from "./run-database.js";
import { SqliteRunEventLedger } from "./run-events.js";
import { SqliteRunLedger } from "./run-ledger.js";
import type { SqliteRunStoreContext } from "./run-store-context.js";

export type SqliteRunStoreOptions = {
  readonly filePath: string;
  readonly busyTimeoutMs?: number;
  readonly projectionBatchSize?: number;
  readonly projectionCatchUpLimit?: number;
  readonly maxRecordBytes?: number;
  readonly maxEventBytes?: number;
  readonly cursorTtlMs?: number;
  readonly catalogHistoryRetentionMs?: number;
  readonly now?: () => Date;
};

export type SqliteRunStore = {
  readonly ledger: RunLedgerPort;
  readonly events: RunEventLedgerPort;
  readonly catalog: RunCatalogPort;
  readonly projector: RunCatalogProjectorPort;
  readonly reconciler: RunReconcilerPort;
  close(): void;
};

function boundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw runStoreError(
      "run_invalid_input",
      `${label} must be between ${minimum} and ${maximum}`
    );
  }
  return value;
}

export async function createSqliteRunStore(
  options: SqliteRunStoreOptions
): Promise<SqliteRunStore> {
  const projectionBatchSize = boundedInteger(
    options.projectionBatchSize ?? 500,
    "Projection batch size",
    1,
    10_000
  );
  const projectionCatchUpLimit = boundedInteger(
    options.projectionCatchUpLimit ?? 100_000,
    "Projection catch-up limit",
    projectionBatchSize,
    1_000_000
  );
  const maxRecordBytes = boundedInteger(
    options.maxRecordBytes ?? 1_048_576,
    "Maximum run record size",
    1_024,
    16_777_216
  );
  const maxEventBytes = boundedInteger(
    options.maxEventBytes ?? 262_144,
    "Maximum run event size",
    1_024,
    4_194_304
  );
  const cursorTtlMs = boundedInteger(
    options.cursorTtlMs ?? 900_000,
    "Cursor TTL",
    1_000,
    86_400_000
  );
  const catalogHistoryRetentionMs = boundedInteger(
    options.catalogHistoryRetentionMs ?? 3_600_000,
    "Catalog history retention",
    cursorTtlMs,
    604_800_000
  );
  const database = await openSqliteRunDatabase({
    filePath: options.filePath,
    ...(options.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: options.busyTimeoutMs })
  });
  const context: SqliteRunStoreContext = {
    database,
    now: options.now ?? (() => new Date()),
    projectionBatchSize,
    projectionCatchUpLimit,
    maxRecordBytes,
    maxEventBytes,
    cursorTtlMs,
    catalogHistoryRetentionMs,
    lastCatalogPruneAtMs: null,
    closed: false
  };
  const ledger = new SqliteRunLedger(context);
  const events = new SqliteRunEventLedger(context);
  const catalog = new SqliteRunCatalog(context);

  return {
    ledger,
    events,
    catalog,
    projector: catalog,
    reconciler: ledger,
    close() {
      if (context.closed) {
        return;
      }
      context.closed = true;
      closeSqliteRunDatabase(database);
    }
  };
}
