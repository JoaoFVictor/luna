import { z } from "zod";
import {
  RunCatalogItemSchema,
  RunCatalogSummarySchema,
  RunOpaqueIdSchema,
  type RunCatalogItem,
  type RunCatalogPage,
  type RunCatalogSummary,
  type RunRecord
} from "../../contracts/runs.js";
import {
  RunCatalogListQuerySchema,
  type RunCatalogListQuery,
  type RunCatalogPort,
  type RunCatalogProjectorPort
} from "../../application/runs/ports.js";
import {
  runDisplayStatus,
  wallDurationMs
} from "../../application/runs/lifecycle.js";
import { runStoreError } from "../../application/runs/errors.js";
import { parseRunContract } from "../../application/runs/validation.js";
import { recordFromJson } from "./run-codec.js";
import {
  assertCursorBinding,
  cursorQueryHash,
  decodeRunCursor,
  encodeRunCursor,
  type RunCursor
} from "./run-cursor.js";
import {
  projectPendingRunCatalog,
  readCatalogMetadata,
  rebuildRunCatalog
} from "./run-catalog-projector.js";
import {
  runStatement,
  withReadTransaction
} from "./run-database.js";
import {
  assertRunStoreOpen,
  assertRunCursorFresh,
  catchUpRunCatalog,
  pruneExpiredRunCatalog,
  runStoreNow,
  type SqliteRunStoreContext
} from "./run-store-context.js";

type CatalogRow = {
  run_id: string;
  workflow_id: string;
  status: string;
  source: string | null;
  correlation_id: string | null;
  job_id: string | null;
  created_at: string;
  created_at_ms: number;
  record_json: string;
};

function queryIdentity(query: z.infer<typeof RunCatalogListQuerySchema>): unknown {
  return {
    direction: query.direction,
    filters: {
      ...query.filters,
      statuses: [...query.filters.statuses].sort()
    }
  };
}

function recordFromCatalogRow(row: CatalogRow): RunRecord {
  const record = recordFromJson(row.record_json);
  if (record.run_id !== row.run_id || record.workflow_id !== row.workflow_id ||
    runDisplayStatus(record) !== row.status || (record.source ?? null) !== row.source ||
    (record.correlation_id ?? null) !== row.correlation_id ||
    (record.job_id ?? null) !== row.job_id || record.created_at !== row.created_at ||
    Date.parse(record.created_at) !== row.created_at_ms) {
    throw runStoreError("run_store_corrupt", "Run catalog projection is inconsistent");
  }
  return record;
}

function catalogItem(row: CatalogRow, asOf: string): RunCatalogItem {
  const record = recordFromCatalogRow(row);
  const item = RunCatalogItemSchema.safeParse({
    record,
    status: row.status,
    wall_duration_ms: wallDurationMs(record, asOf)
  });
  if (!item.success) {
    throw runStoreError("run_store_corrupt", "Run catalog item is invalid");
  }
  return item.data;
}

function catalogSummary(row: CatalogRow, asOf: string): RunCatalogSummary {
  const record = recordFromCatalogRow(row);
  const summary = RunCatalogSummarySchema.safeParse({
    run_id: record.run_id,
    ...(record.correlation_id === undefined ? {} : { correlation_id: record.correlation_id }),
    ...(record.job_id === undefined ? {} : { job_id: record.job_id }),
    workflow_id: record.workflow_id,
    ...(record.workflow_revision === undefined
      ? {}
      : { workflow_revision: record.workflow_revision }),
    ...(record.execution_snapshot_hash === undefined
      ? {}
      : { execution_snapshot_hash: record.execution_snapshot_hash }),
    dispatch_status: record.dispatch_status,
    ...(record.run_status === undefined ? {} : { run_status: record.run_status }),
    status: runDisplayStatus(record),
    created_at: record.created_at,
    ...(record.started_at === undefined ? {} : { started_at: record.started_at }),
    ...(record.finished_at === undefined ? {} : { finished_at: record.finished_at }),
    ...(record.source === undefined ? {} : { source: record.source }),
    ...(record.subject === undefined ? {} : { subject: record.subject }),
    ...(record.repository_id === undefined ? {} : { repository_id: record.repository_id }),
    ...(record.failed_node_id === undefined ? {} : { failed_node_id: record.failed_node_id }),
    artifact_count: record.artifact_count,
    interrupt_count: record.interrupt_count,
    completeness: record.completeness,
    wall_duration_ms: wallDurationMs(record, asOf)
  });
  if (!summary.success) {
    throw runStoreError("run_store_corrupt", "Run catalog summary is invalid");
  }
  return summary.data;
}

function cursorForCatalogPage(
  record: Pick<RunRecord, "created_at" | "run_id">,
  input: {
    generation: string;
    queryHash: string;
    direction: "asc" | "desc";
    snapshot: number;
    asOf: string;
    secret: string;
  }
): string {
  return encodeRunCursor({
    version: 1,
    kind: "catalog",
    generation: input.generation,
    query_hash: input.queryHash,
    direction: input.direction,
    snapshot: input.snapshot,
    as_of: input.asOf,
    last_created_at: record.created_at,
    last_run_id: record.run_id
  }, input.secret);
}

export class SqliteRunCatalog implements RunCatalogPort, RunCatalogProjectorPort {
  readonly #context: SqliteRunStoreContext;

  constructor(context: SqliteRunStoreContext) {
    this.#context = context;
  }

  async get(runId: string): Promise<RunCatalogItem | undefined> {
    assertRunStoreOpen(this.#context);
    const id = parseRunContract(RunOpaqueIdSchema, runId, "catalog query");
    catchUpRunCatalog(this.#context);
    const now = runStoreNow(this.#context);
    pruneExpiredRunCatalog(this.#context, now);
    return withReadTransaction(this.#context.database, () => {
      const row = runStatement(this.#context.database, `
        SELECT run_id, workflow_id, status, source, correlation_id, job_id,
          created_at, created_at_ms, record_json
        FROM studio_run_catalog_versions
        WHERE run_id = ? AND valid_to_epoch IS NULL
      `).get(id) as CatalogRow | undefined;
      return row === undefined
        ? undefined
        : catalogItem(row, now);
    });
  }

  async list(input: RunCatalogListQuery = {}): Promise<RunCatalogPage> {
    assertRunStoreOpen(this.#context);
    const query = parseRunContract(RunCatalogListQuerySchema, input, "catalog query");
    catchUpRunCatalog(this.#context);
    const now = runStoreNow(this.#context);
    pruneExpiredRunCatalog(this.#context, now);
    return withReadTransaction(this.#context.database, () => {
      const metadata = readCatalogMetadata(this.#context.database);
      const queryHash = cursorQueryHash(queryIdentity(query));
      let cursor: RunCursor | undefined;
      if (query.cursor !== undefined) {
        cursor = decodeRunCursor(query.cursor, metadata.cursor_secret);
        assertCursorBinding(cursor, {
          kind: "catalog",
          generation: metadata.catalog_generation,
          queryHash,
          direction: query.direction
        });
        assertRunCursorFresh(this.#context, cursor.as_of, now);
        if (cursor.snapshot > metadata.catalog_epoch) {
          throw runStoreError("run_cursor_invalid", "Run cursor snapshot is unavailable");
        }
      }

      const snapshot = cursor?.snapshot ?? metadata.catalog_epoch;
      const asOf = cursor?.as_of ?? now;
      const conditions = [
        "valid_from_epoch <= ?",
        "(valid_to_epoch IS NULL OR valid_to_epoch > ?)"
      ];
      const parameters: Array<string | number> = [snapshot, snapshot];
      if (query.filters.workflow_id !== undefined) {
        conditions.push("workflow_id = ?");
        parameters.push(query.filters.workflow_id);
      }
      if (query.filters.statuses.length > 0) {
        conditions.push(`status IN (${query.filters.statuses.map(() => "?").join(", ")})`);
        parameters.push(...query.filters.statuses);
      }
      if (query.filters.source !== undefined) {
        conditions.push("source = ?");
        parameters.push(query.filters.source);
      }
      if (query.filters.created_from !== undefined) {
        conditions.push("created_at_ms >= ?");
        parameters.push(Date.parse(query.filters.created_from));
      }
      if (query.filters.created_to !== undefined) {
        conditions.push("created_at_ms <= ?");
        parameters.push(Date.parse(query.filters.created_to));
      }
      if (query.filters.correlation_id !== undefined) {
        conditions.push("correlation_id = ?");
        parameters.push(query.filters.correlation_id);
      }
      if (query.filters.job_id !== undefined) {
        conditions.push("job_id = ?");
        parameters.push(query.filters.job_id);
      }
      if (cursor !== undefined) {
        const operator = query.direction === "asc" ? ">" : "<";
        conditions.push(`(
          created_at_ms ${operator} ?
          OR (created_at_ms = ? AND run_id ${operator} ?)
        )`);
        const createdAtMs = Date.parse(cursor.last_created_at ?? "");
        if (!Number.isFinite(createdAtMs)) {
          throw runStoreError("run_cursor_invalid", "Run cursor time is invalid");
        }
        parameters.push(
          createdAtMs,
          createdAtMs,
          cursor.last_run_id ?? ""
        );
      }
      parameters.push(query.limit + 1);
      const direction = query.direction.toUpperCase();
      const rows = runStatement(this.#context.database, `
        SELECT run_id, workflow_id, status, source, correlation_id, job_id,
          created_at, created_at_ms, record_json
        FROM studio_run_catalog_versions
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at_ms ${direction}, run_id ${direction}
        LIMIT ?
      `).all(...parameters) as CatalogRow[];
      const hasMore = rows.length > query.limit;
      const items = rows.slice(0, query.limit).map((row) => catalogSummary(row, asOf));
      const last = items.at(-1);
      return {
        items,
        next_cursor: hasMore && last !== undefined
          ? cursorForCatalogPage(last, {
              generation: metadata.catalog_generation,
              queryHash,
              direction: query.direction,
              snapshot,
              asOf,
              secret: metadata.cursor_secret
            })
          : null,
        as_of: asOf
      };
    });
  }

  async projectPending(options: { limit?: number } = {}): Promise<number> {
    assertRunStoreOpen(this.#context);
    return projectPendingRunCatalog(
      this.#context.database,
      options.limit ?? this.#context.projectionBatchSize,
      Date.parse(runStoreNow(this.#context))
    );
  }

  async rebuild(): Promise<number> {
    assertRunStoreOpen(this.#context);
    return rebuildRunCatalog(
      this.#context.database,
      Date.parse(runStoreNow(this.#context))
    );
  }
}
