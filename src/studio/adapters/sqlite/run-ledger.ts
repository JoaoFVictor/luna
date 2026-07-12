import { z } from "zod";
import {
  RunRecordSchema,
  RunOpaqueIdSchema,
  type RunRecord
} from "../../contracts/runs.js";
import {
  AppendRunTransitionInputSchema,
  HistoricalRunImportSchema,
  PreallocateRunInputSchema,
  type AppendRunTransitionInput,
  type HistoricalRunImport,
  type PreallocateRunInput,
  type RunLedgerPort,
  type RunMutationResult,
  type RunOrphanCandidate,
  type RunReconcilerPort
} from "../../application/runs/ports.js";
import {
  applyRunTransition,
  initialRunRecord,
  runTransitionEventType
} from "../../application/runs/lifecycle.js";
import { runStoreError } from "../../application/runs/errors.js";
import { parseRunContract } from "../../application/runs/validation.js";
import {
  boundedCanonicalJson,
  commandHash,
  recordFromRow,
  type RunRow
} from "./run-codec.js";
import {
  runStatement,
  withImmediateTransaction,
  withReadTransaction
} from "./run-database.js";
import {
  assertRunStoreOpen,
  type SqliteRunStoreContext
} from "./run-store-context.js";
import {
  appendTransitionEvent,
  assertEventIdAvailable,
  insertFirstEvent,
  insertOutbox,
  insertRun,
  insertTransition,
  projectionPendingAfterBestEffort,
  selectRun,
  selectTransition,
  updateRun
} from "./run-ledger-persistence.js";

export class SqliteRunLedger implements RunLedgerPort, RunReconcilerPort {
  readonly #context: SqliteRunStoreContext;

  constructor(context: SqliteRunStoreContext) {
    this.#context = context;
  }

  async preallocate(input: PreallocateRunInput): Promise<RunMutationResult> {
    assertRunStoreOpen(this.#context);
    const command = parseRunContract(PreallocateRunInputSchema, input, "ledger command");
    const hash = commandHash(command);
    const result = withImmediateTransaction(this.#context.database, () => {
      const existingRecord = selectRun(this.#context.database, command.run_id);
      if (existingRecord !== undefined) {
        const transition = selectTransition(
          this.#context.database,
          command.run_id,
          command.transition_id
        );
        if (transition !== undefined) {
          if (transition.command_hash !== hash) {
            throw runStoreError(
              "run_idempotency_conflict",
              "Transition id was reused with different content",
              { run_id: command.run_id }
            );
          }
          return {
            record: existingRecord,
            applied: false,
            transition_revision: transition.result_revision
          };
        }
        throw runStoreError("run_already_exists", "Run id is already allocated", {
          run_id: command.run_id
        });
      }

      const record = initialRunRecord(command);
      const payload = boundedCanonicalJson(
        record,
        this.#context.maxRecordBytes,
        "run record"
      );
      insertRun(this.#context.database, record, payload);
      insertTransition(this.#context.database, {
        runId: record.run_id,
        transitionId: command.transition_id,
        commandHash: hash,
        resultRevision: record.record_revision,
        kind: "preallocate",
        occurredAt: record.created_at
      });
      insertFirstEvent(this.#context.database, {
        schema_version: 1,
        run_id: record.run_id,
        sequence: 1,
        event_id: command.event_id,
        event_type: "run.dispatch.queued",
        occurred_at: record.created_at,
        record_revision: record.record_revision,
        data: {
          transition_id: command.transition_id,
          dispatch_status: "queued",
          record_revision: record.record_revision
        }
      }, hash, this.#context.maxEventBytes);
      insertOutbox(this.#context.database, record, payload);
      return { record, applied: true, transition_revision: record.record_revision };
    });
    const projectionPending = projectionPendingAfterBestEffort(this.#context);
    return { ...result, catalog_projection_pending: projectionPending };
  }

  async appendTransition(input: AppendRunTransitionInput): Promise<RunMutationResult> {
    assertRunStoreOpen(this.#context);
    const command = parseRunContract(
      AppendRunTransitionInputSchema,
      input,
      "ledger command"
    );
    const lifecycleProjection =
      command.transition.kind === "node_lifecycle" ||
      command.transition.kind === "lifecycle_projection_degraded";
    const hash = commandHash({
      run_id: command.run_id,
      transition_id: command.transition_id,
      event_id: command.event_id,
      ...(lifecycleProjection ? {} : { occurred_at: command.occurred_at }),
      transition: command.transition
    });
    const result = withImmediateTransaction(this.#context.database, () => {
      const current = selectRun(this.#context.database, command.run_id);
      if (current === undefined) {
        throw runStoreError("run_not_found", "Run does not exist", { run_id: command.run_id });
      }
      const existing = selectTransition(
        this.#context.database,
        command.run_id,
        command.transition_id
      );
      if (existing !== undefined) {
        if (existing.command_hash !== hash) {
          throw runStoreError(
            "run_idempotency_conflict",
            "Transition id was reused with different content",
            { run_id: command.run_id }
          );
        }
        return {
          record: current,
          applied: false,
          transition_revision: existing.result_revision
        };
      }
      assertEventIdAvailable(this.#context.database, command.run_id, command.event_id);
      if (current.record_revision !== command.expected_revision) {
        throw runStoreError("run_revision_conflict", "Run revision does not match", {
          run_id: command.run_id,
          expected_revision: command.expected_revision,
          actual_revision: current.record_revision
        });
      }

      const next = applyRunTransition(current, command.transition, command.occurred_at);
      const payload = boundedCanonicalJson(
        next,
        this.#context.maxRecordBytes,
        "run record"
      );
      updateRun(this.#context.database, next, command.expected_revision, payload);
      insertTransition(this.#context.database, {
        runId: next.run_id,
        transitionId: command.transition_id,
        commandHash: hash,
        resultRevision: next.record_revision,
        kind: command.transition.kind,
        occurredAt: command.occurred_at
      });
      appendTransitionEvent(this.#context.database, {
        runId: next.run_id,
        eventId: command.event_id,
        eventType: runTransitionEventType(command.transition),
        occurredAt: command.occurred_at,
        recordRevision: next.record_revision,
        commandHash: hash,
        maxEventBytes: this.#context.maxEventBytes,
        data: {
          transition_id: command.transition_id,
          kind: command.transition.kind,
          previous_dispatch_status: current.dispatch_status,
          previous_run_status: current.run_status ?? null,
          dispatch_status: next.dispatch_status,
          run_status: next.run_status ?? null,
          record_revision: next.record_revision,
          active_node_ids: next.active_node_ids,
          ...(next.artifact_count === undefined
            ? {}
            : { artifact_count: next.artifact_count }),
          ...(next.interrupt_count === undefined
            ? {}
            : { interrupt_count: next.interrupt_count }),
          ...(command.transition.kind === "node_lifecycle"
            ? { node_event: command.transition.event }
            : {}),
          ...(command.transition.kind === "lifecycle_projection_degraded"
            ? { failed_event: command.transition.failed_event }
            : {})
        }
      });
      insertOutbox(this.#context.database, next, payload);
      return { record: next, applied: true, transition_revision: next.record_revision };
    });
    const projectionPending = projectionPendingAfterBestEffort(this.#context);
    return { ...result, catalog_projection_pending: projectionPending };
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    assertRunStoreOpen(this.#context);
    const id = parseRunContract(RunOpaqueIdSchema, runId, "ledger command");
    return withReadTransaction(this.#context.database, () =>
      selectRun(this.#context.database, id));
  }

  async listOrphanCandidates(input: {
    stale_before: string;
    limit?: number;
    cursor?: { readonly stale_since: string; readonly run_id: string };
  }): Promise<readonly RunOrphanCandidate[]> {
    assertRunStoreOpen(this.#context);
    const query = parseRunContract(
      z.object({
        heartbeat_at: z.string().datetime({ offset: true }),
        limit: z.number().int().safe().min(1).max(200).default(50),
        cursor: z.object({
          stale_since: z.string().datetime({ offset: true }),
          run_id: RunOpaqueIdSchema
        }).strict().optional()
      }).strict(),
      {
        heartbeat_at: input.stale_before,
        limit: input.limit,
        cursor: input.cursor
      },
      "ledger command"
    );
    return withReadTransaction(this.#context.database, () => {
      const cursorClause = query.cursor === undefined
        ? ""
        : `AND (
            heartbeat_at_ms > ?
            OR (heartbeat_at_ms = ? AND run_id > ?)
          )`;
      const statement = runStatement(this.#context.database, `
        SELECT run_id, schema_version, record_revision, dispatch_status, run_status,
          heartbeat_at, heartbeat_at_ms, created_at, created_at_ms,
          updated_at, updated_at_ms, record_json
        FROM studio_runs
        WHERE heartbeat_at_ms IS NOT NULL
          AND heartbeat_at_ms < ?
          AND (
            dispatch_status = 'preparing'
            OR (
              dispatch_status = 'started'
              AND run_status IN ('running', 'waiting_for_retry', 'resuming')
            )
          )
        ${cursorClause}
        ORDER BY heartbeat_at_ms ASC, run_id ASC
        LIMIT ?
      `);
      const rows = query.cursor === undefined
        ? statement.all(Date.parse(query.heartbeat_at), query.limit) as RunRow[]
        : statement.all(
            Date.parse(query.heartbeat_at),
            Date.parse(query.cursor.stale_since),
            Date.parse(query.cursor.stale_since),
            query.cursor.run_id,
            query.limit
          ) as RunRow[];
      return rows.map((row) => {
        const record = recordFromRow(row);
        if (record.heartbeat_at === undefined) {
          throw runStoreError("run_store_corrupt", "Orphan candidate has no heartbeat");
        }
        return { record, stale_since: record.heartbeat_at };
      });
    });
  }

  async importHistorical(input: HistoricalRunImport): Promise<RunMutationResult> {
    assertRunStoreOpen(this.#context);
    const command = parseRunContract(HistoricalRunImportSchema, input, "ledger command");
    const hash = commandHash(command);
    const result = withImmediateTransaction(this.#context.database, () => {
      const current = selectRun(this.#context.database, command.record.run_id);
      if (current !== undefined) {
        const transition = selectTransition(
          this.#context.database,
          current.run_id,
          command.transition_id
        );
        if (transition === undefined) {
          throw runStoreError("run_already_exists", "Run id is already allocated", {
            run_id: current.run_id
          });
        }
        if (transition.command_hash !== hash) {
          throw runStoreError(
            "run_idempotency_conflict",
            "Transition id was reused with different content",
            { run_id: current.run_id }
          );
        }
        return {
          record: current,
          applied: false,
          transition_revision: transition.result_revision
        };
      }

      const record = RunRecordSchema.parse(command.record);
      const payload = boundedCanonicalJson(
        record,
        this.#context.maxRecordBytes,
        "run record"
      );
      insertRun(this.#context.database, record, payload);
      insertTransition(this.#context.database, {
        runId: record.run_id,
        transitionId: command.transition_id,
        commandHash: hash,
        resultRevision: record.record_revision,
        kind: "historical_import",
        occurredAt: record.updated_at
      });
      insertFirstEvent(this.#context.database, {
        schema_version: 1,
        run_id: record.run_id,
        sequence: 1,
        event_id: command.event_id,
        event_type: "run.reconciled.historical",
        occurred_at: record.updated_at,
        record_revision: record.record_revision,
        data: {
          transition_id: command.transition_id,
          completeness: record.completeness,
          record_revision: record.record_revision
        }
      }, hash, this.#context.maxEventBytes);
      insertOutbox(this.#context.database, record, payload);
      return { record, applied: true, transition_revision: record.record_revision };
    });
    const projectionPending = projectionPendingAfterBestEffort(this.#context);
    return { ...result, catalog_projection_pending: projectionPending };
  }
}
