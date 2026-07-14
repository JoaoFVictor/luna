import { canonicalJson } from "../../../core/workflow/definition-digests.js";
import { runStoreError } from "../../application/runs/errors.js";
import {
  CompleteStudioRunResumeInputSchema,
  MarkStudioRunResumeEffectInputSchema,
  StudioRunResumeCommandMaterialSchema,
  StudioRunResumeRecordSchema,
  studioRunResumeCommand,
  studioRunResumeCommandMaterial,
  studioRunResumeRecord,
  type CompleteStudioRunResumeInput,
  type MarkStudioRunResumeEffectInput,
  type RunResumeJournalPort,
  type StudioRunResumeCommandMaterial,
  type StudioRunResumeRecord
} from "../../application/runs/resume-journal.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";
import {
  runStatement,
  withImmediateTransaction,
  withReadTransaction
} from "./run-database.js";
import {
  assertRunStoreOpen,
  runStoreNow,
  type SqliteRunStoreContext
} from "./run-store-context.js";

type SafeSchema<T> = {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: T }
    | { readonly success: false };
};

type ResumeRow = {
  resume_id: string;
  schema_version: number;
  run_id: string;
  interrupt_id: string;
  command_hash: string;
  stage: string;
  effect_node_id: string | null;
  accepted_at: string;
  accepted_at_ms: number;
  completed_at: string | null;
  completed_at_ms: number | null;
  record_json: string;
};

function parseResumeInput<T>(schema: SafeSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw runStoreError("run_invalid_input", "Run resume request is invalid");
  }
  return parsed.data;
}

function parseResumeRecordJson(value: string): StudioRunResumeRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(value) as unknown;
  } catch {
    throw runStoreError(
      "run_store_corrupt",
      "Run store contains invalid resume JSON"
    );
  }
  const parsed = StudioRunResumeRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw runStoreError(
      "run_store_corrupt",
      "Run store contains an invalid resume record"
    );
  }
  return parsed.data;
}

function resumeRecordFromRow(row: ResumeRow): StudioRunResumeRecord {
  const record = parseResumeRecordJson(row.record_json);
  const effectNodeId = record.stage.kind === "effect_may_have_occurred"
    ? record.stage.node_id
    : record.stage.kind === "completed"
      ? record.stage.effect_node_id ?? null
      : null;
  const completedAt = record.stage.kind === "completed"
    ? record.stage.completed_at
    : null;
  if (
    record.resume_id !== row.resume_id ||
    record.schema_version !== row.schema_version ||
    record.run_id !== row.run_id ||
    record.interrupt_id !== row.interrupt_id ||
    record.command_hash !== row.command_hash ||
    record.stage.kind !== row.stage ||
    effectNodeId !== row.effect_node_id ||
    record.accepted_at !== row.accepted_at ||
    Date.parse(record.accepted_at) !== row.accepted_at_ms ||
    completedAt !== row.completed_at ||
    (completedAt === null ? null : Date.parse(completedAt)) !==
      row.completed_at_ms
  ) {
    throw runStoreError(
      "run_store_corrupt",
      "Run resume record projection is inconsistent"
    );
  }
  return record;
}

function boundedResumeJson(
  context: SqliteRunStoreContext,
  record: StudioRunResumeRecord
): string {
  const json = canonicalJson(record);
  if (Buffer.byteLength(json, "utf8") > context.maxRecordBytes) {
    throw runStoreError(
      "run_invalid_input",
      "Run resume record exceeds its storage limit"
    );
  }
  return json;
}

function selectResume(
  context: SqliteRunStoreContext,
  resumeId: string
): StudioRunResumeRecord | undefined {
  const row = runStatement(context.database, `
    SELECT resume_id, schema_version, run_id, interrupt_id, command_hash,
      stage, effect_node_id, accepted_at, accepted_at_ms, completed_at,
      completed_at_ms, record_json
    FROM studio_run_resumes
    WHERE resume_id = ?
  `).get(resumeId) as ResumeRow | undefined;
  return row === undefined ? undefined : resumeRecordFromRow(row);
}

function selectResumeForInterrupt(
  context: SqliteRunStoreContext,
  runId: string,
  interruptId: string
): StudioRunResumeRecord | undefined {
  const row = runStatement(context.database, `
    SELECT resume_id, schema_version, run_id, interrupt_id, command_hash,
      stage, effect_node_id, accepted_at, accepted_at_ms, completed_at,
      completed_at_ms, record_json
    FROM studio_run_resumes
    WHERE run_id = ? AND interrupt_id = ?
  `).get(runId, interruptId) as ResumeRow | undefined;
  return row === undefined ? undefined : resumeRecordFromRow(row);
}

function idempotencyConflict(resumeId: string): never {
  throw runStoreError(
    "run_idempotency_conflict",
    "Resume id or interrupt was reused with a different command",
    { resume_id: resumeId }
  );
}

export class SqliteRunResumeJournal implements RunResumeJournalPort {
  readonly #context: SqliteRunStoreContext;

  constructor(context: SqliteRunStoreContext) {
    this.#context = context;
  }

  async accept(material: StudioRunResumeCommandMaterial): Promise<{
    readonly record: StudioRunResumeRecord;
    readonly created: boolean;
  }> {
    assertRunStoreOpen(this.#context);
    const supplied = parseResumeInput(
      StudioRunResumeCommandMaterialSchema,
      material
    );
    return withImmediateTransaction(this.#context.database, () => {
      const existing = selectResume(this.#context, supplied.resume_id);
      if (existing !== undefined) {
        const retry = studioRunResumeCommand({
          ...supplied,
          accepted_at: existing.accepted_at
        });
        if (retry.command_hash !== existing.command_hash) {
          return idempotencyConflict(supplied.resume_id);
        }
        return { record: existing, created: false };
      }

      const run = runStatement(this.#context.database, `
        SELECT 1 AS present FROM studio_runs WHERE run_id = ?
      `).get(supplied.run_id) as { present: number } | undefined;
      if (run === undefined) {
        throw runStoreError("run_not_found", "Run does not exist", {
          run_id: supplied.run_id
        });
      }

      const acceptedInterrupt = selectResumeForInterrupt(
        this.#context,
        supplied.run_id,
        supplied.interrupt_id
      );
      if (acceptedInterrupt !== undefined) {
        return idempotencyConflict(supplied.resume_id);
      }

      const command = studioRunResumeCommand(supplied);
      const record = studioRunResumeRecord({
        command,
        stage: { kind: "pre_execution" }
      });
      runStatement(this.#context.database, `
        INSERT INTO studio_run_resumes (
          resume_id, schema_version, run_id, interrupt_id, command_hash,
          stage, effect_node_id, accepted_at, accepted_at_ms, completed_at,
          completed_at_ms, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?)
      `).run(
        record.resume_id,
        record.schema_version,
        record.run_id,
        record.interrupt_id,
        record.command_hash,
        record.stage.kind,
        record.accepted_at,
        Date.parse(record.accepted_at),
        boundedResumeJson(this.#context, record)
      );
      return { record, created: true };
    });
  }

  async get(resumeId: string): Promise<StudioRunResumeRecord | undefined> {
    assertRunStoreOpen(this.#context);
    const id = parseResumeInput(RunOpaqueIdSchema, resumeId);
    return withReadTransaction(this.#context.database, () =>
      selectResume(this.#context, id));
  }

  async list(): Promise<readonly StudioRunResumeRecord[]> {
    assertRunStoreOpen(this.#context);
    return withReadTransaction(this.#context.database, () => {
      const rows = runStatement(this.#context.database, `
        SELECT resume_id, schema_version, run_id, interrupt_id, command_hash,
          stage, effect_node_id, accepted_at, accepted_at_ms, completed_at,
          completed_at_ms, record_json
        FROM studio_run_resumes
        WHERE stage != 'completed'
        ORDER BY accepted_at_ms ASC, resume_id ASC
      `).all() as ResumeRow[];
      return rows.map(resumeRecordFromRow);
    });
  }

  async markEffectMayHaveOccurred(
    input: MarkStudioRunResumeEffectInput
  ): Promise<StudioRunResumeRecord> {
    assertRunStoreOpen(this.#context);
    const command = parseResumeInput(
      MarkStudioRunResumeEffectInputSchema,
      input
    );
    return withImmediateTransaction(this.#context.database, () => {
      const current = selectResume(this.#context, command.resume_id);
      if (current === undefined) {
        throw runStoreError("run_not_found", "Run resume does not exist", {
          resume_id: command.resume_id
        });
      }
      if (current.command_hash !== command.command_hash) {
        return idempotencyConflict(command.resume_id);
      }
      if (current.stage.kind !== "pre_execution") {
        return current;
      }

      const next = studioRunResumeRecord({
        command: studioRunResumeCommand(
          studioRunResumeCommandMaterial(current)
        ),
        stage: {
          kind: "effect_may_have_occurred",
          node_id: command.node_id
        }
      });
      const updated = runStatement(this.#context.database, `
        UPDATE studio_run_resumes
        SET stage = ?, effect_node_id = ?, record_json = ?
        WHERE resume_id = ? AND command_hash = ? AND stage = 'pre_execution'
      `).run(
        next.stage.kind,
        command.node_id,
        boundedResumeJson(this.#context, next),
        command.resume_id,
        command.command_hash
      );
      if (Number(updated.changes) !== 1) {
        throw runStoreError(
          "run_store_corrupt",
          "Run resume stage could not be advanced atomically"
        );
      }
      return next;
    });
  }

  async complete(input: CompleteStudioRunResumeInput): Promise<boolean> {
    assertRunStoreOpen(this.#context);
    const command = parseResumeInput(CompleteStudioRunResumeInputSchema, input);
    return withImmediateTransaction(this.#context.database, () => {
      const current = selectResume(this.#context, command.resume_id);
      if (current === undefined) {
        return false;
      }
      if (current.command_hash !== command.command_hash) {
        return idempotencyConflict(command.resume_id);
      }
      if (current.stage.kind === "completed") {
        return true;
      }
      const completedAt = runStoreNow(this.#context);
      if (Date.parse(completedAt) < Date.parse(current.accepted_at)) {
        throw runStoreError(
          "run_invalid_input",
          "Run store clock cannot precede resume acceptance"
        );
      }
      const completed = studioRunResumeRecord({
        command: studioRunResumeCommand(
          studioRunResumeCommandMaterial(current)
        ),
        stage: {
          kind: "completed",
          completed_at: completedAt,
          ...(current.stage.kind === "effect_may_have_occurred"
            ? { effect_node_id: current.stage.node_id }
            : {})
        }
      });
      const updated = runStatement(this.#context.database, `
        UPDATE studio_run_resumes
        SET stage = 'completed', completed_at = ?, completed_at_ms = ?,
          record_json = ?
        WHERE resume_id = ? AND command_hash = ? AND stage != 'completed'
      `).run(
        completedAt,
        Date.parse(completedAt),
        boundedResumeJson(this.#context, completed),
        command.resume_id,
        command.command_hash
      );
      if (Number(updated.changes) !== 1) {
        throw runStoreError(
          "run_store_corrupt",
          "Run resume record could not be completed atomically"
        );
      }
      return true;
    });
  }
}
