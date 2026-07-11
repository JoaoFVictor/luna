import type { DatabaseSync } from "node:sqlite";
import { runStoreError } from "../../application/runs/errors.js";
import {
  projectPendingRunCatalog,
  pruneRunCatalogHistory
} from "./run-catalog-projector.js";
import { runStatement, withReadTransaction } from "./run-database.js";

export type SqliteRunStoreContext = {
  readonly database: DatabaseSync;
  readonly now: () => Date;
  readonly projectionBatchSize: number;
  readonly projectionCatchUpLimit: number;
  readonly maxRecordBytes: number;
  readonly maxEventBytes: number;
  readonly cursorTtlMs: number;
  readonly catalogHistoryRetentionMs: number;
  lastCatalogPruneAtMs: number | null;
  closed: boolean;
};

export function assertRunStoreOpen(context: SqliteRunStoreContext): void {
  if (context.closed) {
    throw runStoreError("run_store_closed", "Run store is closed");
  }
}

export function runStoreNow(context: SqliteRunStoreContext): string {
  const value = context.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw runStoreError("run_invalid_input", "Run store clock returned an invalid time");
  }
  return value.toISOString();
}

export function assertRunCursorFresh(
  context: SqliteRunStoreContext,
  cursorAsOf: string,
  now: string
): void {
  const age = Date.parse(now) - Date.parse(cursorAsOf);
  if (!Number.isFinite(age) || age < 0) {
    throw runStoreError("run_cursor_invalid", "Run cursor time is invalid");
  }
  if (age > context.cursorTtlMs) {
    throw runStoreError("run_cursor_expired", "Run cursor has expired");
  }
}

export function hasPendingProjection(context: SqliteRunStoreContext): boolean {
  const row = withReadTransaction(context.database, () =>
    runStatement(context.database, `
      SELECT EXISTS(SELECT 1 FROM studio_run_outbox LIMIT 1) AS pending
    `).get() as { pending: number });
  return row.pending === 1;
}

export function catchUpRunCatalog(context: SqliteRunStoreContext): number {
  assertRunStoreOpen(context);
  let total = 0;
  while (total < context.projectionCatchUpLimit) {
    const remaining = context.projectionCatchUpLimit - total;
    const processed = projectPendingRunCatalog(
      context.database,
      Math.min(context.projectionBatchSize, remaining),
      Date.parse(runStoreNow(context))
    );
    total += processed;
    if (processed < Math.min(context.projectionBatchSize, remaining)) {
      return total;
    }
  }
  if (hasPendingProjection(context)) {
    throw runStoreError(
      "run_store_busy",
      "Run catalog projection backlog exceeds the bounded catch-up limit"
    );
  }
  return total;
}

export function pruneExpiredRunCatalog(
  context: SqliteRunStoreContext,
  now: string
): number {
  const nowMs = Date.parse(now);
  const interval = Math.min(60_000, Math.max(1_000, context.catalogHistoryRetentionMs / 4));
  if (context.lastCatalogPruneAtMs !== null && nowMs >= context.lastCatalogPruneAtMs &&
    nowMs - context.lastCatalogPruneAtMs < interval) {
    return 0;
  }
  const pruned = pruneRunCatalogHistory(
    context.database,
    nowMs - context.catalogHistoryRetentionMs
  );
  context.lastCatalogPruneAtMs = nowMs;
  return pruned;
}
