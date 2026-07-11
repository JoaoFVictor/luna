import { z } from "zod";
import {
  RunEventSchema,
  type RunEvent,
  type RunEventPage
} from "../../contracts/runs.js";
import {
  AppendRunEventInputSchema,
  RunEventListQuerySchema,
  type AppendRunEventInput,
  type RunEventAppendResult,
  type RunEventLedgerPort,
  type RunEventListQuery
} from "../../application/runs/ports.js";
import { runStoreError } from "../../application/runs/errors.js";
import { parseRunContract } from "../../application/runs/validation.js";
import {
  boundedCanonicalJson,
  commandHash,
  eventFromRow,
  recordFromJson,
  type RunEventRow
} from "./run-codec.js";
import {
  assertCursorBinding,
  cursorQueryHash,
  decodeRunCursor,
  encodeRunCursor,
  type RunCursor
} from "./run-cursor.js";
import { readCatalogMetadata } from "./run-catalog-projector.js";
import {
  runStatement,
  withImmediateTransaction,
  withReadTransaction
} from "./run-database.js";
import {
  assertRunStoreOpen,
  assertRunCursorFresh,
  runStoreNow,
  type SqliteRunStoreContext
} from "./run-store-context.js";

type StoredEventRow = RunEventRow & { command_hash: string };

function existingEvent(
  context: SqliteRunStoreContext,
  runId: string,
  eventId: string
): StoredEventRow | undefined {
  const row = runStatement(context.database, `
    SELECT run_id, sequence, event_id, command_hash, event_type, occurred_at,
      occurred_at_ms, record_revision, data_json
    FROM studio_run_events WHERE run_id = ? AND event_id = ?
  `).get(runId, eventId) as StoredEventRow | undefined;
  if (row !== undefined && !/^sha256:[a-f0-9]{64}$/.test(row.command_hash)) {
    throw runStoreError("run_store_corrupt", "Run event idempotency record is invalid");
  }
  return row;
}

function runLifecycleBounds(
  context: SqliteRunStoreContext,
  runId: string
): { created_at: string; finished_at?: string } | undefined {
  const row = runStatement(context.database, `
    SELECT record_json FROM studio_runs WHERE run_id = ?
  `).get(runId) as { record_json: string } | undefined;
  if (row === undefined) {
    return undefined;
  }
  const record = recordFromJson(row.record_json);
  return {
    created_at: record.created_at,
    ...(record.finished_at === undefined ? {} : { finished_at: record.finished_at })
  };
}

function appendEvent(
  context: SqliteRunStoreContext,
  command: z.infer<typeof AppendRunEventInputSchema>,
  hash: string
): RunEventAppendResult {
  const existing = existingEvent(context, command.run_id, command.event_id);
  if (existing !== undefined) {
    if (existing.command_hash !== hash) {
      throw runStoreError(
        "run_event_id_conflict",
        "Event id was reused with different content",
        { run_id: command.run_id }
      );
    }
    return { event: eventFromRow(existing), applied: false };
  }

  const bounds = runLifecycleBounds(context, command.run_id);
  if (bounds === undefined) {
    throw runStoreError("run_not_found", "Run does not exist", { run_id: command.run_id });
  }
  const occurred = Date.parse(command.occurred_at);
  if (occurred < Date.parse(bounds.created_at) ||
    (bounds.finished_at !== undefined && occurred > Date.parse(bounds.finished_at))) {
    throw runStoreError(
      "run_transition_invalid",
      "Event time is outside the run lifecycle",
      { run_id: command.run_id }
    );
  }

  const head = runStatement(context.database, `
    SELECT last_sequence FROM studio_run_event_heads WHERE run_id = ?
  `).get(command.run_id) as { last_sequence: number } | undefined;
  if (head === undefined || !Number.isSafeInteger(head.last_sequence) ||
    head.last_sequence < 1) {
    throw runStoreError("run_store_corrupt", "Run event head is unavailable");
  }
  if (head.last_sequence !== command.expected_last_sequence) {
    throw runStoreError(
      "run_event_sequence_conflict",
      "Run event sequence changed before append",
      {
        run_id: command.run_id,
        expected_sequence: command.expected_last_sequence,
        actual_sequence: head.last_sequence
      }
    );
  }

  const previous = runStatement(context.database, `
    SELECT sequence, occurred_at, occurred_at_ms FROM studio_run_events
    WHERE run_id = ?
    ORDER BY sequence DESC
    LIMIT 1
  `).get(command.run_id) as {
    sequence: number;
    occurred_at: string;
    occurred_at_ms: number;
  } | undefined;
  if (previous === undefined || previous.sequence !== head.last_sequence ||
    Date.parse(previous.occurred_at) !== previous.occurred_at_ms) {
    throw runStoreError("run_store_corrupt", "Run event sequence projection is invalid");
  }
  if (occurred < previous.occurred_at_ms) {
    throw runStoreError(
      "run_transition_invalid",
      "Event time cannot precede the previous event",
      { run_id: command.run_id }
    );
  }

  const sequence = head.last_sequence + 1;
  if (!Number.isSafeInteger(sequence)) {
    throw runStoreError("run_store_corrupt", "Run event sequence is exhausted");
  }
  const event = RunEventSchema.parse({
    schema_version: 1,
    run_id: command.run_id,
    sequence,
    event_id: command.event_id,
    event_type: command.event_type,
    occurred_at: command.occurred_at,
    data: command.data
  });
  const dataJson = boundedCanonicalJson(
    event.data,
    context.maxEventBytes,
    "run event"
  );
  const updated = runStatement(context.database, `
    UPDATE studio_run_event_heads SET last_sequence = ?
    WHERE run_id = ? AND last_sequence = ?
  `).run(sequence, command.run_id, head.last_sequence);
  if (Number(updated.changes) !== 1) {
    throw runStoreError(
      "run_event_sequence_conflict",
      "Run event sequence changed before append",
      { run_id: command.run_id }
    );
  }
  runStatement(context.database, `
    INSERT INTO studio_run_events (
      run_id, sequence, event_id, command_hash, event_type, occurred_at,
      occurred_at_ms, record_revision, data_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    event.run_id,
    event.sequence,
    event.event_id,
    hash,
    event.event_type,
    event.occurred_at,
    Date.parse(event.occurred_at),
    dataJson
  );
  return { event, applied: true };
}

function queryIdentity(query: z.infer<typeof RunEventListQuerySchema>): unknown {
  return {
    run_id: query.run_id,
    direction: query.direction,
    event_types: [...query.event_types].sort()
  };
}

function pageCursor(
  last: RunEvent,
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
    kind: "events",
    generation: input.generation,
    query_hash: input.queryHash,
    direction: input.direction,
    snapshot: input.snapshot,
    as_of: input.asOf,
    run_id: last.run_id,
    last_sequence: last.sequence,
    last_event_id: last.event_id
  }, input.secret);
}

export class SqliteRunEventLedger implements RunEventLedgerPort {
  readonly #context: SqliteRunStoreContext;

  constructor(context: SqliteRunStoreContext) {
    this.#context = context;
  }

  async append(input: AppendRunEventInput): Promise<RunEventAppendResult> {
    assertRunStoreOpen(this.#context);
    const command = parseRunContract(AppendRunEventInputSchema, input, "event request");
    const hash = commandHash({
      run_id: command.run_id,
      event_id: command.event_id,
      event_type: command.event_type,
      occurred_at: command.occurred_at,
      data: command.data
    });
    return withImmediateTransaction(this.#context.database, () =>
      appendEvent(this.#context, command, hash));
  }

  async list(input: RunEventListQuery): Promise<RunEventPage> {
    assertRunStoreOpen(this.#context);
    const query = parseRunContract(RunEventListQuerySchema, input, "event request");
    const now = runStoreNow(this.#context);
    return withReadTransaction(this.#context.database, () => {
      const metadata = readCatalogMetadata(this.#context.database);
      const queryHash = cursorQueryHash(queryIdentity(query));
      const head = runStatement(this.#context.database, `
        SELECT last_sequence FROM studio_run_event_heads WHERE run_id = ?
      `).get(query.run_id) as { last_sequence: number } | undefined;
      if (head === undefined) {
        throw runStoreError("run_not_found", "Run does not exist", { run_id: query.run_id });
      }
      if (!Number.isSafeInteger(head.last_sequence) || head.last_sequence < 1) {
        throw runStoreError("run_store_corrupt", "Run event head is invalid");
      }

      let cursor: RunCursor | undefined;
      if (query.cursor !== undefined) {
        cursor = decodeRunCursor(query.cursor, metadata.cursor_secret);
        assertCursorBinding(cursor, {
          kind: "events",
          generation: metadata.catalog_generation,
          queryHash,
          direction: query.direction
        });
        assertRunCursorFresh(this.#context, cursor.as_of, now);
        if (cursor.run_id !== query.run_id || cursor.snapshot > head.last_sequence) {
          throw runStoreError("run_cursor_invalid", "Run cursor does not match this timeline");
        }
      }

      const snapshot = cursor?.snapshot ?? head.last_sequence;
      const asOf = cursor?.as_of ?? now;
      const parameters: Array<string | number> = [query.run_id, snapshot];
      const conditions = ["run_id = ?", "sequence <= ?"];
      if (query.event_types.length > 0) {
        conditions.push(`event_type IN (${query.event_types.map(() => "?").join(", ")})`);
        parameters.push(...query.event_types);
      }
      if (cursor !== undefined) {
        const operator = query.direction === "asc" ? ">" : "<";
        conditions.push(`(sequence ${operator} ? OR (sequence = ? AND event_id ${operator} ?))`);
        parameters.push(cursor.last_sequence ?? 0, cursor.last_sequence ?? 0,
          cursor.last_event_id ?? "");
      }
      parameters.push(query.limit + 1);
      const rows = runStatement(this.#context.database, `
        SELECT run_id, sequence, event_id, event_type, occurred_at,
          occurred_at_ms, record_revision, data_json
        FROM studio_run_events
        WHERE ${conditions.join(" AND ")}
        ORDER BY sequence ${query.direction.toUpperCase()}, event_id ${query.direction.toUpperCase()}
        LIMIT ?
      `).all(...parameters) as RunEventRow[];
      const hasMore = rows.length > query.limit;
      const items = rows.slice(0, query.limit).map(eventFromRow);
      const last = items.at(-1);
      return {
        items,
        next_cursor: hasMore && last !== undefined
          ? pageCursor(last, {
              generation: metadata.catalog_generation,
              queryHash,
              direction: query.direction,
              snapshot,
              asOf,
              secret: metadata.cursor_secret
            })
          : null,
        as_of_sequence: snapshot
      };
    });
  }
}
