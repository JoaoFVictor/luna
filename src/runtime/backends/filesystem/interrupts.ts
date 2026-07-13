import { chmod, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { z } from "zod";
import type { BackendRegistration } from "../../../core/runtime/backends/contracts.js";
import type {
  InterruptRecord,
  PagedInterruptStore
} from "../../../core/runtime/interrupts/contracts.js";
import { resumeInputsEqual } from "../../../core/runtime/interrupts/resume.js";
import { runtimeError } from "../../../core/runtime/errors.js";
import { stableJson } from "../../../core/runtime/json.js";
import { safeJoin } from "../../../core/security/path.js";
import { atomicWriteFile } from "../../../core/artifacts/atomic-write.js";
import { RunLockManager } from "../../../core/workflow/lock-manager.js";
import {
  decodeInterruptPageCursor,
  encodeInterruptPageCursor,
  InterruptPageCursorError
} from "../../../core/runtime/interrupts/page-cursor.js";

export const FilesystemInterruptBackendOptionsSchema = z
  .object({ root: z.string().min(1) })
  .strict();

export const filesystemInterruptBackendRegistration = {
  id: "filesystem.interrupts",
  kind: "interrupt",
  optionsSchema: FilesystemInterruptBackendOptionsSchema
} satisfies BackendRegistration<z.infer<typeof FilesystemInterruptBackendOptionsSchema>>;

export type FilesystemInterruptStoreOptions = {
  root: string;
};

const writeTails = new Map<string, Promise<unknown>>();

const LegacyInterruptIndexSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  run_id: z.string().min(1),
  entries: z.array(z.object({
    id: z.string().min(1),
    created_at: z.string().datetime({ offset: true })
  }).passthrough())
}).strict();

const InterruptIndexMarkerSchema = z.object({
  version: z.literal(1),
  run_id: z.string().min(1),
  interrupt_id: z.string().min(1)
}).strict();

type InterruptIndexRow = {
  readonly run_id: string;
  readonly id: string;
  readonly created_at: string;
  readonly thread_id: string | null;
  readonly checkpoint_id: string | null;
  readonly node_id: string | null;
  readonly status: InterruptRecord["status"];
};

export function createFilesystemInterruptStore({
  root
}: FilesystemInterruptStoreOptions): PagedInterruptStore {
  const resumeLocks = new RunLockManager({
    root: path.join(path.resolve(root), ".resume-locks"),
    runId: "interrupt-resume-store",
    timeoutMs: 30_000,
    staleAfterMs: 60_000
  });
  const indexLocks = new RunLockManager({
    root: path.join(path.resolve(root), ".index-locks"),
    runId: "interrupt-index-store",
    timeoutMs: 30_000,
    staleAfterMs: 60_000
  });
  const legacyIndexRoot = path.join(path.resolve(root), ".index");
  const indexDatabasePath = path.join(path.resolve(root), ".interrupt-index.sqlite");
  const markerRoot = path.join(path.resolve(root), ".index-pending");
  let indexDatabase: DatabaseSync | undefined;
  async function filePath(id: string): Promise<string> {
    return await safeJoin(root, [`${encodeURIComponent(id)}.json`]);
  }

  async function readRecord(id: string): Promise<InterruptRecord | undefined> {
    try {
      return JSON.parse(await readFile(await filePath(id), "utf8")) as InterruptRecord;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw cause;
    }
  }

  async function writeRecord(record: InterruptRecord): Promise<void> {
    await mkdir(root, { recursive: true });
    await atomicWriteFile(
      await filePath(record.id),
      `${JSON.stringify(record, null, 2)}\n`,
      0o600
    );
  }

  function encoded(value: string): string {
    return encodeURIComponent(value);
  }

  function markerDirectory(runId: string): string {
    return path.join(markerRoot, encoded(runId));
  }

  function markerFilePath(runId: string, interruptId: string): string {
    return path.join(markerDirectory(runId), `${encoded(interruptId)}.json`);
  }

  async function database(): Promise<DatabaseSync> {
    if (indexDatabase !== undefined) return indexDatabase;
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const opened = new DatabaseSync(indexDatabasePath);
    opened.exec("PRAGMA journal_mode = WAL");
    opened.exec("PRAGMA synchronous = FULL");
    opened.exec("PRAGMA busy_timeout = 30000");
    opened.exec(`CREATE TABLE IF NOT EXISTS interrupt_indexed_runs (
      run_id TEXT PRIMARY KEY,
      indexed_at TEXT NOT NULL
    ) STRICT`);
    opened.exec(`CREATE TABLE IF NOT EXISTS interrupt_index (
      run_id TEXT NOT NULL,
      id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      thread_id TEXT,
      checkpoint_id TEXT,
      node_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'resuming', 'resolved', 'cancelled')),
      PRIMARY KEY (run_id, id)
    ) STRICT`);
    opened.exec(`CREATE INDEX IF NOT EXISTS interrupt_index_run_created
      ON interrupt_index(run_id, created_at DESC, id DESC)`);
    opened.exec(`CREATE INDEX IF NOT EXISTS interrupt_index_thread_checkpoint_status
      ON interrupt_index(run_id, thread_id, checkpoint_id, status, created_at DESC, id DESC)`);
    opened.exec(`CREATE INDEX IF NOT EXISTS interrupt_index_node_created
      ON interrupt_index(run_id, node_id, created_at DESC, id DESC)`);
    opened.exec(`CREATE INDEX IF NOT EXISTS interrupt_index_status_created
      ON interrupt_index(run_id, status, created_at DESC, id DESC)`);
    await chmod(indexDatabasePath, 0o600);
    indexDatabase = opened;
    return opened;
  }

  async function recordsForRun(runId: string): Promise<InterruptRecord[]> {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const records = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) =>
          JSON.parse(await readFile(path.join(root, entry.name), "utf8")) as InterruptRecord
        ));
      return records.filter((record) => record.run_id === runId);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
  }

  async function recordsFromLegacyIndex(runId: string): Promise<InterruptRecord[] | undefined> {
    try {
      const legacy = LegacyInterruptIndexSchema.parse(JSON.parse(await readFile(
        path.join(legacyIndexRoot, `${encoded(runId)}.json`),
        "utf8"
      )) as unknown);
      if (legacy.run_id !== runId) {
        throw runtimeError("Interrupt index belongs to another run", "runtime_state_invalid");
      }
      return await Promise.all(legacy.entries.map(async (entry) => {
        const record = await readRecord(entry.id);
        if (
          record === undefined ||
          record.run_id !== runId ||
          record.created_at !== entry.created_at
        ) {
          throw runtimeError("Legacy interrupt index references invalid state", "runtime_state_invalid");
        }
        return record;
      }));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  }

  async function pendingMarkerIds(runId: string): Promise<string[]> {
    try {
      const entries = await readdir(markerDirectory(runId), { withFileTypes: true });
      const markers = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => InterruptIndexMarkerSchema.parse(
          JSON.parse(await readFile(path.join(markerDirectory(runId), entry.name), "utf8")) as unknown
        )));
      if (markers.some((marker) => marker.run_id !== runId)) {
        throw runtimeError("Interrupt index marker belongs to another run", "runtime_state_invalid");
      }
      return markers.map((marker) => marker.interrupt_id);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
  }

  async function removeMarker(runId: string, interruptId: string): Promise<void> {
    await unlink(markerFilePath(runId, interruptId)).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause;
    });
  }

  async function ensureRunIndexed(runId: string): Promise<DatabaseSync> {
    const db = await database();
    const indexed = db.prepare(
      "SELECT 1 AS present FROM interrupt_indexed_runs WHERE run_id = ? LIMIT 1"
    ).get(runId);
    if (indexed !== undefined) return db;
    const records = await recordsFromLegacyIndex(runId) ?? await recordsForRun(runId);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) upsertIndexRecord(db, record);
      db.prepare(
        "INSERT OR IGNORE INTO interrupt_indexed_runs(run_id, indexed_at) VALUES (?, ?)"
      ).run(runId, new Date().toISOString());
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }
    return db;
  }

  async function reconcileIndex(runId: string): Promise<DatabaseSync> {
    const db = await ensureRunIndexed(runId);
    const markerIds = await pendingMarkerIds(runId);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const interruptId of markerIds) {
        const record = await readRecord(interruptId);
        if (record !== undefined) {
          if (record.run_id !== runId) {
            throw runtimeError("Interrupt index marker references another run", "runtime_state_invalid");
          }
          upsertIndexRecord(db, record);
        }
      }
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }
    await Promise.all(markerIds.map((interruptId) => removeMarker(runId, interruptId)));
    return db;
  }

  async function markIndexPending(record: InterruptRecord): Promise<void> {
    await mkdir(markerDirectory(record.run_id), { recursive: true });
    await atomicWriteFile(markerFilePath(record.run_id, record.id), `${JSON.stringify({
      version: 1,
      run_id: record.run_id,
      interrupt_id: record.id
    })}\n`, 0o600);
  }

  async function indexRecord(record: InterruptRecord): Promise<void> {
    const db = await ensureRunIndexed(record.run_id);
    upsertIndexRecord(db, record);
    await removeMarker(record.run_id, record.id);
  }

  async function withRecordTail<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = writeTails.get(id) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    writeTails.set(id, next.catch(() => undefined));

    return await next;
  }

  return {
    async create(record) {
      await withRecordTail(record.id, async () => {
        const release = await indexLocks.acquire(`run:${record.run_id}`, "exclusive");
        try {
          await reconcileIndex(record.run_id);
          const existing = await readRecord(record.id);
          if (existing !== undefined) {
            if (stableJson(existing) === stableJson(record)) {
              await indexRecord(existing);
              return;
            }
            throw runtimeError(
              "Interrupt identity already belongs to different durable state",
              "interrupt_conflict",
              { details: { interrupt_id: record.id } }
            );
          }
          await markIndexPending(record);
          await writeRecord({ ...record });
          await indexRecord(record);
        } finally {
          await release();
        }
      });
    },
    async get(id) {
      const record = await readRecord(id);

      return record === undefined ? undefined : structuredClone(record);
    },
    async list(runId) {
      return (await recordsForRun(runId)).map((record) => structuredClone(record));
    },
    async findFirst(runId, query) {
      const release = await indexLocks.acquire(`run:${runId}`, "exclusive");
      try {
        if (query.node_ids?.length === 0 || query.statuses?.length === 0) return undefined;
        const db = await reconcileIndex(runId);
        const clauses = ["run_id = ?"];
        const parameters: Array<string | number> = [runId];
        if (query.exclude_id !== undefined) {
          clauses.push("id <> ?");
          parameters.push(query.exclude_id);
        }
        if (query.thread_id !== undefined) {
          clauses.push("thread_id = ?");
          parameters.push(query.thread_id);
        }
        if (query.checkpoint_id !== undefined) {
          clauses.push("checkpoint_id = ?");
          parameters.push(query.checkpoint_id);
        }
        if (query.node_ids !== undefined) {
          clauses.push(`node_id IN (${query.node_ids.map(() => "?").join(", ")})`);
          parameters.push(...query.node_ids);
        }
        if (query.created_after !== undefined) {
          clauses.push("created_at > ?");
          parameters.push(query.created_after);
        }
        if (query.statuses !== undefined) {
          clauses.push(`status IN (${query.statuses.map(() => "?").join(", ")})`);
          parameters.push(...query.statuses);
        }
        const row = db.prepare(`SELECT run_id, id, created_at, thread_id,
          checkpoint_id, node_id, status
          FROM interrupt_index
          WHERE ${clauses.join(" AND ")}
          ORDER BY created_at DESC, id DESC
          LIMIT 1`).get(...parameters) as InterruptIndexRow | undefined;
        return row === undefined
          ? undefined
          : structuredClone(await readIndexedRecord(row));
      } finally {
        await release();
      }
    },
    async listPage(runId, query) {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200) {
        throw runtimeError("Interrupt page limit is invalid", "runtime_state_invalid");
      }
      const release = await indexLocks.acquire(`run:${runId}`, "exclusive");
      try {
        const db = await reconcileIndex(runId);
        const cursor = query.cursor === undefined
          ? undefined
          : decodeInterruptPageCursor(runId, query.cursor);
        if (cursor !== undefined) {
          const exists = db.prepare(`SELECT 1 AS present FROM interrupt_index
            WHERE run_id = ? AND id = ? AND created_at = ? LIMIT 1`
          ).get(runId, cursor.interrupt_id, cursor.created_at);
          if (exists === undefined) {
            throw new InterruptPageCursorError("Interrupt page cursor is stale");
          }
        }
        const rows = db.prepare(`SELECT run_id, id, created_at, thread_id,
          checkpoint_id, node_id, status
          FROM interrupt_index
          WHERE run_id = ?${cursor === undefined ? "" :
            " AND (created_at < ? OR (created_at = ? AND id < ?))"}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`).all(
            runId,
            ...(cursor === undefined
              ? []
              : [cursor.created_at, cursor.created_at, cursor.interrupt_id]),
            query.limit + 1
          ) as unknown as InterruptIndexRow[];
        const hasMore = rows.length > query.limit;
        const selected = rows.slice(0, query.limit);
        const records = await Promise.all(selected.map(async (row) =>
          structuredClone(await readIndexedRecord(row))
        ));
        return {
          records,
          next_cursor: hasMore && records.length > 0
            ? encodeInterruptPageCursor(runId, records.at(-1)!)
            : null
        };
      } finally {
        await release();
      }
    },
    async withResumeLease(id, operation) {
      const release = await resumeLocks.acquire(`interrupt:${id}`, "exclusive");
      let operationFailure: unknown;
      try {
        return await operation();
      } catch (cause) {
        operationFailure = cause;
        throw cause;
      } finally {
        try {
          await release();
        } catch (cause) {
          if (operationFailure === undefined) {
            throw cause;
          }
        }
      }
    },
    async beginResume(id, resumeAttempt, input) {
      return await withRecordTail(id, async () =>
        await withLockedRecord(id, async (interrupt) => {
          if (interrupt.status === "resolved" && interrupt.resume !== undefined) {
            if (!resumeInputsEqual(input, interrupt.resume.input)) {
              throw runtimeError(
                "Interrupt has already been resumed with different input",
                "interrupt_conflict",
                { details: { interrupt_id: id } }
              );
            }

            return {
              interrupt_id: id,
              resume_attempt: interrupt.resume.resume_id,
              status: "duplicate" as const,
              resume: structuredClone(interrupt.resume)
            };
          }

          if (interrupt.status === "resuming") {
            if (
              interrupt.resume_attempt === undefined ||
              interrupt.resume_input === undefined
            ) {
              throw runtimeError(
                "Interrupt already has a resume attempt in progress",
                "runtime_interrupt_resume_in_progress",
                { details: { interrupt_id: id } }
              );
            }
            if (!resumeInputsEqual(input, interrupt.resume_input)) {
              throw runtimeError(
                "Interrupt has already been resumed with different input",
                "interrupt_conflict",
                { details: { interrupt_id: id } }
              );
            }

            return {
              interrupt_id: id,
              resume_attempt: interrupt.resume_attempt,
              status: "claimed" as const
            };
          }

          if (interrupt.status !== "pending") {
            throw runtimeError(
              "Interrupt cannot be resumed from its current status",
              "runtime_interrupt_status_invalid",
              { details: { interrupt_id: id, status: interrupt.status } }
            );
          }

          await persistIndexedRecord({
            ...interrupt,
            status: "resuming",
            resume_attempt: resumeAttempt,
            resume_input: structuredClone(input),
            updated_at: new Date().toISOString()
          });

          return {
            interrupt_id: id,
            resume_attempt: resumeAttempt,
            status: "claimed" as const
          };
        })
      );
    },
    async completeResume(id, claim, status, resume) {
      await withRecordTail(id, async () =>
        await withLockedRecord(id, async (interrupt) => {
          if (
            interrupt.status !== "resuming" ||
            interrupt.resume_attempt !== claim.resume_attempt
          ) {
            throw runtimeError(
              "Interrupt resume is not in progress",
              "runtime_interrupt_status_invalid",
              {
                details: {
                  interrupt_id: id,
                  status: interrupt.status,
                  resume_attempt: interrupt.resume_attempt,
                  claim_resume_attempt: claim.resume_attempt
                }
              }
            );
          }

          await persistIndexedRecord({
            ...interrupt,
            status,
            resume_input: undefined,
            ...(resume === undefined ? {} : { resume }),
            updated_at: new Date().toISOString()
          });
        })
      );
    }
  };

  async function readRequiredRecord(id: string): Promise<InterruptRecord> {
    const interrupt = await readRecord(id);
    if (interrupt === undefined) {
      throw runtimeError("Interrupt not found", "runtime_interrupt_not_found", {
        details: { interrupt_id: id }
      });
    }

    return interrupt;
  }

  async function withLockedRecord<T>(
    id: string,
    operation: (record: InterruptRecord) => Promise<T>
  ): Promise<T> {
    const initial = await readRequiredRecord(id);
    const release = await indexLocks.acquire(`run:${initial.run_id}`, "exclusive");
    try {
      await reconcileIndex(initial.run_id);
      const current = await readRequiredRecord(id);
      if (current.run_id !== initial.run_id) {
        throw runtimeError("Interrupt identity changed across its index lock", "runtime_state_invalid");
      }
      return await operation(current);
    } finally {
      await release();
    }
  }

  async function persistIndexedRecord(record: InterruptRecord): Promise<void> {
    await markIndexPending(record);
    await writeRecord(record);
    await indexRecord(record);
  }

  function indexRow(record: InterruptRecord): InterruptIndexRow {
    return {
      run_id: record.run_id,
      id: record.id,
      created_at: record.created_at,
      thread_id: record.thread_id ?? null,
      checkpoint_id: record.checkpoint_id ?? null,
      node_id: record.node_id ?? null,
      status: record.status
    };
  }

  function upsertIndexRecord(db: DatabaseSync, record: InterruptRecord): void {
    const next = indexRow(record);
    const current = db.prepare(`SELECT run_id, id, created_at, thread_id,
      checkpoint_id, node_id, status FROM interrupt_index
      WHERE run_id = ? AND id = ? LIMIT 1`
    ).get(record.run_id, record.id) as InterruptIndexRow | undefined;
    if (
      current !== undefined &&
      (current.created_at !== next.created_at ||
        current.thread_id !== next.thread_id ||
        current.checkpoint_id !== next.checkpoint_id ||
        current.node_id !== next.node_id)
    ) {
      throw runtimeError("Interrupt index identity is inconsistent", "runtime_state_invalid");
    }
    db.prepare(`INSERT INTO interrupt_index(
      run_id, id, created_at, thread_id, checkpoint_id, node_id, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, id) DO UPDATE SET status = excluded.status`
    ).run(
      next.run_id,
      next.id,
      next.created_at,
      next.thread_id,
      next.checkpoint_id,
      next.node_id,
      next.status
    );
  }

  async function readIndexedRecord(row: InterruptIndexRow): Promise<InterruptRecord> {
    const record = await readRecord(row.id);
    if (
      record === undefined ||
      stableJson(indexRow(record)) !== stableJson(row)
    ) {
      throw runtimeError("Interrupt index references invalid state", "runtime_state_invalid");
    }
    return record;
  }
}
