import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import {
  assertRefOnlyCheckpointState,
  type BackendRegistration,
  type CheckpointRecord,
  type CheckpointStore,
  type CheckpointWriteRecord,
  type JsonObject
} from "../../../core/runtime/backends/contracts.js";
import { assertCheckpointJsonObject } from "../../../core/runtime/json.js";
import { assertCheckpointJsonValue } from "../../../core/runtime/json.js";
import { runtimeError } from "../../../core/runtime/errors.js";

export const SqliteCheckpointBackendOptionsSchema = z
  .object({ filePath: z.string().min(1) })
  .strict();
export const sqliteCheckpointBackendRegistration = {
  id: "sqlite.checkpoints",
  kind: "checkpoint",
  optionsSchema: SqliteCheckpointBackendOptionsSchema
} satisfies BackendRegistration<z.infer<typeof SqliteCheckpointBackendOptionsSchema>>;

export type SqliteCheckpointStoreOptions = {
  filePath: string;
};

type CheckpointRow = {
  thread_id: string;
  checkpoint_id: string;
  checkpoint_ns: string;
  state_schema_version: string;
  state_json: string;
  checkpoint_json: string;
  metadata_json: string;
  parent_config_json: string | null;
  created_at: string;
  revision: number;
};

type WriteRow = {
  thread_id: string;
  checkpoint_id: string;
  checkpoint_ns: string;
  task_id: string;
  idx: number;
  channel: string;
  value_json: string;
};

function writeRecordFromRow(row: WriteRow): CheckpointWriteRecord {
  const value = JSON.parse(row.value_json) as unknown;
  assertCheckpointJsonValue(value, "$.write.value");
  return {
    thread_id: row.thread_id,
    checkpoint_ns: row.checkpoint_ns,
    checkpoint_id: row.checkpoint_id,
    task_id: row.task_id,
    index: row.idx,
    channel: row.channel,
    value
  };
}

function conflictingCheckpointWrite(record: CheckpointWriteRecord): Error {
  return runtimeError(
    "Checkpoint write identity already belongs to different durable output",
    "runtime_duplicate_node_output",
    {
      details: {
        thread_id: record.thread_id,
        checkpoint_ns: record.checkpoint_ns,
        checkpoint_id: record.checkpoint_id,
        task_id: record.task_id,
        index: record.index
      }
    }
  );
}

function openDatabase(filePath: string): DatabaseSync {
  const database = new DatabaseSync(filePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS checkpoints (
      thread_id TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL,
      state_schema_version TEXT NOT NULL,
      state_json TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      parent_config_json TEXT,
      created_at TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
    );
    CREATE INDEX IF NOT EXISTS checkpoints_thread_revision
      ON checkpoints(thread_id, revision DESC);
    CREATE TABLE IF NOT EXISTS checkpoint_writes (
      thread_id TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL,
      task_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      channel TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
    );
  `);

  return database;
}

function parseJsonObject(value: string, pathLabel: string): JsonObject {
  const parsed = JSON.parse(value) as unknown;
  assertCheckpointJsonObject(parsed, pathLabel);

  return parsed;
}

function recordFromRow(row: CheckpointRow): CheckpointRecord {
  const state = parseJsonObject(row.state_json, "$.state");
  assertRefOnlyCheckpointState(state);
  const checkpoint = parseJsonObject(row.checkpoint_json, "$.checkpoint");
  if (
    typeof checkpoint.v !== "number" ||
    typeof checkpoint.ts !== "string" ||
    checkpoint.channel_versions === null ||
    typeof checkpoint.channel_versions !== "object" ||
    Array.isArray(checkpoint.channel_versions) ||
    checkpoint.versions_seen === null ||
    typeof checkpoint.versions_seen !== "object" ||
    Array.isArray(checkpoint.versions_seen)
  ) {
    throw runtimeError("Invalid persisted checkpoint metadata", "runtime_invalid_json", {
      details: { thread_id: row.thread_id, checkpoint_id: row.checkpoint_id }
    });
  }

  return {
    thread_id: row.thread_id,
    checkpoint_id: row.checkpoint_id,
    checkpoint_ns: row.checkpoint_ns,
    state_schema_version: row.state_schema_version,
    state,
    checkpoint: {
      v: checkpoint.v,
      ts: checkpoint.ts,
      channel_versions: checkpoint.channel_versions,
      versions_seen: checkpoint.versions_seen
    },
    metadata: parseJsonObject(row.metadata_json, "$.metadata"),
    ...(row.parent_config_json === null
      ? {}
      : { parent_config: parseJsonObject(row.parent_config_json, "$.parent_config") }),
    created_at: row.created_at,
    revision: row.revision
  };
}

function ensureCompatible(
  record: CheckpointRecord,
  expectedStateSchemaVersion: string | undefined
): void {
  if (
    expectedStateSchemaVersion !== undefined &&
    record.state_schema_version !== expectedStateSchemaVersion
  ) {
    throw runtimeError(
      "Checkpoint state schema version is incompatible",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          thread_id: record.thread_id,
          expected: expectedStateSchemaVersion,
          actual: record.state_schema_version
        }
      }
    );
  }
}

export function createSqliteCheckpointStore({
  filePath
}: SqliteCheckpointStoreOptions): CheckpointStore {
  return {
    async save(input) {
      assertRefOnlyCheckpointState(input.state);
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });

      const database = openDatabase(filePath);
      try {
        database.exec("BEGIN IMMEDIATE");
        try {
          const previous = database
            .prepare("SELECT MAX(revision) AS revision FROM checkpoints WHERE thread_id = ?")
            .get(input.thread_id) as { revision: number | null };
          const createdAt = input.created_at ?? new Date().toISOString();
          const record: CheckpointRecord = {
            ...input,
            checkpoint_ns: input.checkpoint_ns ?? "",
            checkpoint: input.checkpoint ?? {
              v: 4,
              ts: createdAt,
              channel_versions: {},
              versions_seen: {}
            },
            metadata: input.metadata ?? {},
            ...(input.parent_config === undefined ? {} : { parent_config: input.parent_config }),
            created_at: createdAt,
            revision: (previous.revision ?? 0) + 1
          };

          database
            .prepare(`
              INSERT INTO checkpoints (
                thread_id,
                checkpoint_id,
                checkpoint_ns,
                state_schema_version,
                state_json,
                checkpoint_json,
                metadata_json,
                parent_config_json,
                created_at,
                revision
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              record.thread_id,
              record.checkpoint_id,
              record.checkpoint_ns,
              record.state_schema_version,
              JSON.stringify(record.state),
              JSON.stringify(record.checkpoint),
              JSON.stringify(record.metadata),
              record.parent_config === undefined
                ? null
                : JSON.stringify(record.parent_config),
              record.created_at,
              record.revision
            );

          database.exec("COMMIT");
          return structuredClone(record);
        } catch (cause) {
          database.exec("ROLLBACK");
          throw cause;
        }
      } finally {
        database.close();
      }
    },
    async load(threadId, options = {}) {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const database = openDatabase(filePath);
      try {
        const row =
          options.checkpointId === undefined
            ? (database
                .prepare(`
                  SELECT * FROM checkpoints
                  WHERE thread_id = ?
                    AND (? IS NULL OR checkpoint_ns = ?)
                  ORDER BY revision DESC
                  LIMIT 1
                `)
                .get(
                  threadId,
                  options.checkpointNs ?? null,
                  options.checkpointNs ?? null
                ) as CheckpointRow | undefined)
            : (database
                .prepare(`
                  SELECT * FROM checkpoints
                  WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
                `)
                .get(threadId, options.checkpointNs ?? "", options.checkpointId) as CheckpointRow | undefined);
        if (row === undefined) {
          return undefined;
        }

        const record = recordFromRow(row);
        ensureCompatible(record, options.expectedStateSchemaVersion);

        return structuredClone(record);
      } finally {
        database.close();
      }
    },
    async list(threadId, options = {}) {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const database = openDatabase(filePath);
      try {
        const before = options.beforeCheckpointId === undefined
          ? undefined
          : (database
              .prepare(`
                SELECT revision FROM checkpoints
                WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
              `)
              .get(threadId, options.beforeCheckpointNs ?? "", options.beforeCheckpointId) as
              | { revision: number }
              | undefined);
        const rows = database
          .prepare(`
            SELECT * FROM checkpoints
            WHERE thread_id = ?
              AND (? IS NULL OR checkpoint_ns = ?)
              AND (? IS NULL OR checkpoint_id = ?)
              AND (? IS NULL OR revision < ?)
            ORDER BY revision DESC
          `)
          .all(
            threadId,
            options.checkpointNs ?? null,
            options.checkpointNs ?? null,
            options.checkpointId ?? null,
            options.checkpointId ?? null,
            before?.revision ?? null,
            before?.revision ?? null
          ) as CheckpointRow[];

        let records = rows.map(recordFromRow);
        if (options.metadataFilter !== undefined) {
          records = records.filter((record) =>
            Object.entries(options.metadataFilter ?? {}).every(
              ([key, value]) => record.metadata[key] === value
            )
          );
        }

        return options.limit === undefined ? records : records.slice(0, options.limit);
      } finally {
        database.close();
      }
    },
    async saveWrites(records) {
      if (records.length === 0) {
        return;
      }

      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const database = openDatabase(filePath);
      try {
        database.exec("BEGIN IMMEDIATE");
        try {
          const insert = database.prepare(`
            INSERT INTO checkpoint_writes (
              thread_id,
              checkpoint_id,
              checkpoint_ns,
              task_id,
              idx,
              channel,
              value_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
            DO NOTHING
          `);
          const existingWrite = database.prepare(`
            SELECT * FROM checkpoint_writes
            WHERE thread_id = ?
              AND checkpoint_ns = ?
              AND checkpoint_id = ?
              AND task_id = ?
              AND idx = ?
          `);

          for (const record of records) {
            assertCheckpointJsonValue(record.value, "$.write.value");
            const result = insert.run(
              record.thread_id,
              record.checkpoint_id,
              record.checkpoint_ns,
              record.task_id,
              record.index,
              record.channel,
              JSON.stringify(record.value)
            );
            if (result.changes === 0) {
              const existing = existingWrite.get(
                record.thread_id,
                record.checkpoint_ns,
                record.checkpoint_id,
                record.task_id,
                record.index
              ) as WriteRow | undefined;
              let existingValue: unknown;
              try {
                existingValue = existing === undefined
                  ? undefined
                  : JSON.parse(existing.value_json) as unknown;
              } catch {
                throw conflictingCheckpointWrite(record);
              }
              if (
                existing === undefined ||
                existing.channel !== record.channel ||
                !isDeepStrictEqual(existingValue, record.value)
              ) {
                throw conflictingCheckpointWrite(record);
              }
            }
          }

          database.exec("COMMIT");
        } catch (cause) {
          database.exec("ROLLBACK");
          throw cause;
        }
      } finally {
        database.close();
      }
    },
    async listWrites(threadId, checkpointNs, checkpointId) {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const database = openDatabase(filePath);
      try {
        const rows = database
          .prepare(`
            SELECT * FROM checkpoint_writes
            WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
            ORDER BY task_id ASC, idx ASC
          `)
          .all(threadId, checkpointNs, checkpointId) as WriteRow[];

        return rows.map(writeRecordFromRow);
      } finally {
        database.close();
      }
    },
    async hasThreadWrites(threadId) {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const database = openDatabase(filePath);
      try {
        const row = database
          .prepare(`
            SELECT 1 AS present FROM checkpoint_writes
            WHERE thread_id = ?
            LIMIT 1
          `)
          .get(threadId) as { present: 1 } | undefined;

        return row !== undefined;
      } finally {
        database.close();
      }
    },
    async deleteThread(threadId) {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const database = openDatabase(filePath);
      try {
        database.exec("BEGIN IMMEDIATE");
        try {
          database
            .prepare("DELETE FROM checkpoint_writes WHERE thread_id = ?")
            .run(threadId);
          database
            .prepare("DELETE FROM checkpoints WHERE thread_id = ?")
            .run(threadId);
          database.exec("COMMIT");
        } catch (cause) {
          database.exec("ROLLBACK");
          throw cause;
        }
      } finally {
        database.close();
      }
    }
  };
}

export function sqliteCheckpointFile(root: string): string {
  return path.join(root, "luna-checkpoints.sqlite");
}
