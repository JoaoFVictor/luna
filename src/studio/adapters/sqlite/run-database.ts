import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { RunStoreError, runStoreError } from "../../application/runs/errors.js";

const RUN_STORE_SCHEMA_VERSION = 2;

export type SqliteRunDatabaseOptions = {
  readonly filePath: string;
  readonly busyTimeoutMs?: number;
};

type SchemaObjectContract = {
  readonly type: "table" | "index";
  readonly name: string;
  readonly tableName: string;
  readonly sql: string;
};

const VERSION_ONE_SCHEMA = [
  {
    type: "table",
    name: "studio_run_schema_migrations",
    tableName: "studio_run_schema_migrations",
    sql: `CREATE TABLE studio_run_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT`
  },
  {
    type: "table",
    name: "studio_run_metadata",
    tableName: "studio_run_metadata",
    sql: `CREATE TABLE studio_run_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      cursor_secret TEXT NOT NULL,
      catalog_generation TEXT NOT NULL,
      catalog_epoch INTEGER NOT NULL CHECK (catalog_epoch >= 0)
    ) STRICT`
  },
  {
    type: "table",
    name: "studio_runs",
    tableName: "studio_runs",
    sql: `CREATE TABLE studio_runs (
      run_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      record_revision INTEGER NOT NULL CHECK (record_revision > 0),
      dispatch_status TEXT NOT NULL,
      run_status TEXT,
      heartbeat_at TEXT,
      heartbeat_at_ms INTEGER,
      created_at TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      record_json TEXT NOT NULL
    ) STRICT`
  },
  {
    type: "index",
    name: "studio_runs_active_heartbeat",
    tableName: "studio_runs",
    sql: `CREATE INDEX studio_runs_active_heartbeat
      ON studio_runs(dispatch_status, run_status, heartbeat_at_ms, run_id)`
  },
  {
    type: "table",
    name: "studio_run_transitions",
    tableName: "studio_run_transitions",
    sql: `CREATE TABLE studio_run_transitions (
      run_id TEXT NOT NULL REFERENCES studio_runs(run_id) ON DELETE RESTRICT,
      transition_id TEXT NOT NULL,
      command_hash TEXT NOT NULL,
      result_revision INTEGER NOT NULL CHECK (result_revision > 0),
      transition_kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      PRIMARY KEY (run_id, transition_id)
    ) STRICT`
  },
  {
    type: "table",
    name: "studio_run_event_heads",
    tableName: "studio_run_event_heads",
    sql: `CREATE TABLE studio_run_event_heads (
      run_id TEXT PRIMARY KEY REFERENCES studio_runs(run_id) ON DELETE RESTRICT,
      last_sequence INTEGER NOT NULL CHECK (last_sequence > 0)
    ) STRICT`
  },
  {
    type: "table",
    name: "studio_run_events",
    tableName: "studio_run_events",
    sql: `CREATE TABLE studio_run_events (
      run_id TEXT NOT NULL REFERENCES studio_runs(run_id) ON DELETE RESTRICT,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      event_id TEXT NOT NULL,
      command_hash TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL,
      record_revision INTEGER,
      data_json TEXT NOT NULL,
      PRIMARY KEY (run_id, sequence),
      UNIQUE (run_id, event_id)
    ) STRICT`
  },
  {
    type: "index",
    name: "studio_run_events_time",
    tableName: "studio_run_events",
    sql: `CREATE INDEX studio_run_events_time
      ON studio_run_events(run_id, occurred_at_ms, sequence, event_id)`
  },
  {
    type: "table",
    name: "studio_run_outbox",
    tableName: "studio_run_outbox",
    sql: `CREATE TABLE studio_run_outbox (
      outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES studio_runs(run_id) ON DELETE RESTRICT,
      record_revision INTEGER NOT NULL CHECK (record_revision > 0),
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (run_id, record_revision)
    ) STRICT`
  },
  {
    type: "table",
    name: "studio_run_catalog_versions",
    tableName: "studio_run_catalog_versions",
    sql: `CREATE TABLE studio_run_catalog_versions (
      run_id TEXT NOT NULL,
      valid_from_epoch INTEGER NOT NULL CHECK (valid_from_epoch > 0),
      valid_to_epoch INTEGER CHECK (valid_to_epoch > valid_from_epoch),
      valid_to_at_ms INTEGER,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT,
      correlation_id TEXT,
      job_id TEXT,
      created_at TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      projected_at_ms INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (run_id, valid_from_epoch),
      CHECK ((valid_to_epoch IS NULL) = (valid_to_at_ms IS NULL)),
      CHECK (valid_to_at_ms IS NULL OR valid_to_at_ms >= projected_at_ms)
    ) STRICT`
  },
  {
    type: "index",
    name: "studio_run_catalog_current",
    tableName: "studio_run_catalog_versions",
    sql: `CREATE UNIQUE INDEX studio_run_catalog_current
      ON studio_run_catalog_versions(run_id)
      WHERE valid_to_epoch IS NULL`
  },
  {
    type: "index",
    name: "studio_run_catalog_created",
    tableName: "studio_run_catalog_versions",
    sql: `CREATE INDEX studio_run_catalog_created
      ON studio_run_catalog_versions(created_at_ms, run_id, valid_from_epoch, valid_to_epoch)`
  },
  {
    type: "index",
    name: "studio_run_catalog_workflow",
    tableName: "studio_run_catalog_versions",
    sql: `CREATE INDEX studio_run_catalog_workflow
      ON studio_run_catalog_versions(workflow_id, created_at_ms, run_id, valid_from_epoch, valid_to_epoch)`
  },
  {
    type: "index",
    name: "studio_run_catalog_status",
    tableName: "studio_run_catalog_versions",
    sql: `CREATE INDEX studio_run_catalog_status
      ON studio_run_catalog_versions(status, created_at_ms, run_id, valid_from_epoch, valid_to_epoch)`
  },
  {
    type: "index",
    name: "studio_run_catalog_source",
    tableName: "studio_run_catalog_versions",
    sql: `CREATE INDEX studio_run_catalog_source
      ON studio_run_catalog_versions(source, created_at_ms, run_id, valid_from_epoch, valid_to_epoch)`
  },
  {
    type: "index",
    name: "studio_run_catalog_correlation",
    tableName: "studio_run_catalog_versions",
    sql: `CREATE INDEX studio_run_catalog_correlation
      ON studio_run_catalog_versions(correlation_id, created_at_ms, run_id, valid_from_epoch, valid_to_epoch)`
  },
  {
    type: "index",
    name: "studio_run_catalog_job",
    tableName: "studio_run_catalog_versions",
    sql: `CREATE INDEX studio_run_catalog_job
      ON studio_run_catalog_versions(job_id, created_at_ms, run_id, valid_from_epoch, valid_to_epoch)`
  },
  {
    type: "index",
    name: "studio_run_catalog_retention",
    tableName: "studio_run_catalog_versions",
    sql: `CREATE INDEX studio_run_catalog_retention
      ON studio_run_catalog_versions(valid_to_at_ms)
      WHERE valid_to_at_ms IS NOT NULL`
  }
] as const satisfies readonly SchemaObjectContract[];

const VERSION_TWO_ADDITIONS = [
  {
    type: "table",
    name: "studio_run_resumes",
    tableName: "studio_run_resumes",
    sql: `CREATE TABLE studio_run_resumes (
      resume_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      run_id TEXT NOT NULL REFERENCES studio_runs(run_id) ON DELETE RESTRICT,
      interrupt_id TEXT NOT NULL,
      command_hash TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (
        stage IN ('pre_execution', 'effect_may_have_occurred', 'completed')
      ),
      effect_node_id TEXT,
      accepted_at TEXT NOT NULL,
      accepted_at_ms INTEGER NOT NULL,
      completed_at TEXT,
      completed_at_ms INTEGER,
      record_json TEXT NOT NULL,
      UNIQUE (run_id, interrupt_id),
      CHECK (
        (stage = 'pre_execution' AND effect_node_id IS NULL AND
          completed_at IS NULL AND completed_at_ms IS NULL) OR
        (stage = 'effect_may_have_occurred' AND effect_node_id IS NOT NULL AND
          completed_at IS NULL AND completed_at_ms IS NULL) OR
        (stage = 'completed' AND completed_at IS NOT NULL AND
          completed_at_ms IS NOT NULL AND completed_at_ms >= accepted_at_ms)
      )
    ) STRICT`
  },
  {
    type: "index",
    name: "studio_run_resumes_accepted",
    tableName: "studio_run_resumes",
    sql: `CREATE INDEX studio_run_resumes_accepted
      ON studio_run_resumes(accepted_at_ms, resume_id)
      WHERE stage != 'completed'`
  }
] as const satisfies readonly SchemaObjectContract[];

const VERSION_TWO_SCHEMA = [
  ...VERSION_ONE_SCHEMA,
  ...VERSION_TWO_ADDITIONS
] as const satisfies readonly SchemaObjectContract[];

function safeDatabaseError(cause: unknown): RunStoreError {
  if (cause instanceof RunStoreError) {
    return cause;
  }
  const code = typeof cause === "object" && cause !== null && "code" in cause
    ? String(cause.code)
    : "";
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return runStoreError("run_store_busy", "Run store is busy; retry the operation");
  }
  return runStoreError("run_store_io_failed", "Run store operation failed");
}

export function runStatement(
  database: DatabaseSync,
  sql: string
): StatementSync {
  try {
    return database.prepare(sql);
  } catch (cause) {
    throw safeDatabaseError(cause);
  }
}

export function withImmediateTransaction<T>(
  database: DatabaseSync,
  operation: () => T
): T {
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (cause) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original failure remains authoritative and the connection is closed by callers.
      }
      throw cause;
    }
  } catch (cause) {
    throw safeDatabaseError(cause);
  }
}

export function withReadTransaction<T>(
  database: DatabaseSync,
  operation: () => T
): T {
  try {
    database.exec("BEGIN");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (cause) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the primary failure.
      }
      throw cause;
    }
  } catch (cause) {
    throw safeDatabaseError(cause);
  }
}

function userVersion(database: DatabaseSync): number {
  const row = runStatement(database, "PRAGMA user_version").get() as {
    user_version: number;
  };
  return row.user_version;
}

function hasPartialRunSchema(database: DatabaseSync): boolean {
  const row = runStatement(database, `
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE (type = 'table' OR type = 'index')
      AND name LIKE 'studio_run_%'
  `).get() as { count: number };
  return row.count > 0;
}

function migrateToVersionOne(database: DatabaseSync): void {
  database.exec(VERSION_ONE_SCHEMA.map(({ sql }) => `${sql};`).join("\n"));

  runStatement(database, `
    INSERT INTO studio_run_metadata (
      singleton, cursor_secret, catalog_generation, catalog_epoch
    ) VALUES (1, ?, ?, 0)
  `).run(randomBytes(32).toString("hex"), randomBytes(18).toString("base64url"));
  runStatement(database, `
    INSERT INTO studio_run_schema_migrations (version, applied_at)
    VALUES (1, ?)
  `).run(new Date().toISOString());
  database.exec("PRAGMA user_version = 1");
}

function migrateToVersionTwo(database: DatabaseSync): void {
  database.exec(VERSION_TWO_ADDITIONS.map(({ sql }) => `${sql};`).join("\n"));
  runStatement(database, `
    INSERT INTO studio_run_schema_migrations (version, applied_at)
    VALUES (2, ?)
  `).run(new Date().toISOString());
  database.exec("PRAGMA user_version = 2");
}

type SchemaObjectRow = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
};

function normalizeSchemaSql(sql: string): string {
  return sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ").toLowerCase();
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validateSchemaObjects(
  database: DatabaseSync,
  expectedSchema: readonly SchemaObjectContract[],
  schemaVersion: number
): void {
  const rows = runStatement(database, `
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE sql IS NOT NULL
      AND (
        name = 'studio_runs' OR tbl_name = 'studio_runs' OR
        name GLOB 'studio_run_*' OR tbl_name GLOB 'studio_run_*'
      )
  `).all() as SchemaObjectRow[];
  const expectedByName = new Map<string, SchemaObjectContract>();
  for (const object of expectedSchema) {
    expectedByName.set(object.name, object);
  }
  if (rows.length !== expectedSchema.length) {
    throw runStoreError(
      "run_store_corrupt",
      "Run store schema does not match its declared version",
      { schema_version: schemaVersion }
    );
  }
  for (const row of rows) {
    const expected = expectedByName.get(row.name);
    if (expected === undefined || row.type !== expected.type ||
      row.tbl_name !== expected.tableName ||
      normalizeSchemaSql(row.sql) !== normalizeSchemaSql(expected.sql)) {
      throw runStoreError(
        "run_store_corrupt",
        "Run store schema does not match its declared version",
        { schema_version: schemaVersion }
      );
    }
  }
}

function validateMigrations(
  database: DatabaseSync,
  expectedVersions: readonly number[],
  schemaVersion: number
): void {
  const migrations = runStatement(database, `
    SELECT version, applied_at
    FROM studio_run_schema_migrations
    ORDER BY version ASC
  `).all() as { version: number; applied_at: string }[];
  if (
    migrations.length !== expectedVersions.length ||
    migrations.some((migration, index) =>
      migration.version !== expectedVersions[index] ||
      !isCanonicalTimestamp(migration.applied_at))
  ) {
    throw runStoreError(
      "run_store_corrupt",
      "Run store migration history is invalid",
      { schema_version: schemaVersion }
    );
  }
}

function validateMetadataAndIntegrity(
  database: DatabaseSync,
  schemaVersion: number
): void {
  const metadata = runStatement(database, `
    SELECT cursor_secret, catalog_generation, catalog_epoch
    FROM studio_run_metadata WHERE singleton = 1
  `).get() as {
    cursor_secret: string;
    catalog_generation: string;
    catalog_epoch: number;
  } | undefined;
  if (metadata === undefined ||
    !/^[a-f0-9]{64}$/.test(metadata.cursor_secret) ||
    !/^[A-Za-z0-9_-]{24}$/.test(metadata.catalog_generation) ||
    !Number.isSafeInteger(metadata.catalog_epoch) || metadata.catalog_epoch < 0) {
    throw runStoreError(
      "run_store_corrupt",
      "Run store metadata is invalid",
      { schema_version: schemaVersion }
    );
  }
  const integrity = runStatement(database, "PRAGMA integrity_check(1)").get() as {
    integrity_check: string;
  };
  const foreignKeyFailure = runStatement(database, "PRAGMA foreign_key_check").get();
  if (integrity.integrity_check !== "ok" || foreignKeyFailure !== undefined) {
    throw runStoreError("run_store_corrupt", "Run store integrity check failed", {
      schema_version: schemaVersion
    });
  }
}

function validateVersionOne(database: DatabaseSync): void {
  const version = userVersion(database);
  if (version !== 1) {
    throw runStoreError(
      "run_store_corrupt",
      "Run store schema version changed unexpectedly",
      { schema_version: version }
    );
  }
  validateSchemaObjects(database, VERSION_ONE_SCHEMA, 1);
  validateMigrations(database, [1], 1);
  validateMetadataAndIntegrity(database, 1);
}

function validateVersionTwo(database: DatabaseSync): void {
  const version = userVersion(database);
  if (version !== 2) {
    throw runStoreError(
      "run_store_corrupt",
      "Run store schema version changed unexpectedly",
      { schema_version: version }
    );
  }
  validateSchemaObjects(database, VERSION_TWO_SCHEMA, 2);
  validateMigrations(database, [1, 2], 2);
  validateMetadataAndIntegrity(database, 2);
}

function migrate(database: DatabaseSync): void {
  withImmediateTransaction(database, () => {
    let version = userVersion(database);
    if (version > RUN_STORE_SCHEMA_VERSION) {
      throw runStoreError(
        "run_store_schema_unsupported",
        "Run store schema is newer than this Luna version",
        { schema_version: version, supported_version: RUN_STORE_SCHEMA_VERSION }
      );
    }
    if (version === 0) {
      if (hasPartialRunSchema(database)) {
        throw runStoreError(
          "run_store_corrupt",
          "Run store contains an incomplete unversioned schema"
        );
      }
      migrateToVersionOne(database);
      version = 1;
    }
    if (version === 1) {
      validateVersionOne(database);
      migrateToVersionTwo(database);
      version = 2;
    }
    if (version === 2) {
      validateVersionTwo(database);
    }
  });
}

async function secureDatabaseLeaf(filePath: string): Promise<FileHandle> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw runStoreError(
      "run_store_io_failed",
      "Run store directory must be a physical directory"
    );
  }
  await chmod(directory, 0o700);

  const handle = await open(
    filePath,
    constants.O_CREAT |
      constants.O_RDWR |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    const [opened, linked] = await Promise.all([
      handle.stat(),
      lstat(filePath)
    ]);
    if (
      !opened.isFile() ||
      linked.isSymbolicLink() ||
      !linked.isFile() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino
    ) {
      throw runStoreError(
        "run_store_io_failed",
        "Run store path must be a physical regular file"
      );
    }
    await handle.chmod(0o600);
    return handle;
  } catch (cause) {
    await handle.close().catch(() => undefined);
    throw cause;
  }
}

export async function openSqliteRunDatabase(
  options: SqliteRunDatabaseOptions
): Promise<DatabaseSync> {
  if (options.filePath.length === 0) {
    throw runStoreError("run_invalid_input", "Run store file path is required");
  }
  const timeout = options.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60_000) {
    throw runStoreError("run_invalid_input", "Busy timeout must be between 0 and 60000 ms");
  }

  try {
    const securedLeaf = await secureDatabaseLeaf(options.filePath);
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(options.filePath);
      const linked = await lstat(options.filePath);
      const opened = await securedLeaf.stat();
      if (
        linked.isSymbolicLink() ||
        !linked.isFile() ||
        opened.dev !== linked.dev ||
        opened.ino !== linked.ino
      ) {
        database.close();
        throw runStoreError(
          "run_store_io_failed",
          "Run store path changed while it was opened"
        );
      }
    } finally {
      await securedLeaf.close();
    }
    try {
      await chmod(options.filePath, 0o600);
      database.exec(`
        PRAGMA busy_timeout = ${timeout};
        PRAGMA foreign_keys = ON;
        PRAGMA trusted_schema = OFF;
      `);
      migrate(database);
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA wal_autocheckpoint = 1000;
      `);
      return database;
    } catch (cause) {
      database.close();
      throw cause;
    }
  } catch (cause) {
    throw safeDatabaseError(cause);
  }
}

export function closeSqliteRunDatabase(database: DatabaseSync): void {
  try {
    database.close();
  } catch (cause) {
    throw safeDatabaseError(cause);
  }
}
