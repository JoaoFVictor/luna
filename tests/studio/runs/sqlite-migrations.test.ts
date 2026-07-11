import path from "node:path";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteRunStore } from "../../../src/studio/adapters/sqlite/run-store.js";
import { initialRunRecord } from "../../../src/studio/application/runs/lifecycle.js";
import { preallocation, withRunStore } from "./helpers.js";

async function withDatabasePath(
  operation: (context: { root: string; filePath: string }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-run-migrations-"));
  try {
    await operation({ root, filePath: path.join(root, "runs.sqlite") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const TABLE_SCHEMA_TAMPERING = [
  [
    "NOT NULL",
    "studio_runs",
    "record_revision INTEGER NOT NULL CHECK (record_revision > 0)",
    "record_revision INTEGER CHECK (record_revision > 0)"
  ],
  [
    "CHECK",
    "studio_runs",
    "CHECK (record_revision > 0)",
    "CHECK (record_revision >= 0)"
  ],
  [
    "foreign key action",
    "studio_run_transitions",
    "REFERENCES studio_runs(run_id) ON DELETE RESTRICT",
    "REFERENCES studio_runs(run_id) ON DELETE CASCADE"
  ],
  [
    "UNIQUE",
    "studio_run_outbox",
    "UNIQUE (run_id, record_revision)",
    "UNIQUE (run_id)"
  ],
  [
    "primary key order",
    "studio_run_transitions",
    "PRIMARY KEY (run_id, transition_id)",
    "PRIMARY KEY (transition_id, run_id)"
  ],
  [
    "STRICT",
    "studio_runs",
    ") STRICT",
    ")"
  ]
] as const;

const INDEX_SCHEMA_TAMPERING = [
  [
    "column order",
    `DROP INDEX studio_runs_active_heartbeat;
     CREATE INDEX studio_runs_active_heartbeat
       ON studio_runs(run_id, heartbeat_at_ms, run_status, dispatch_status);`
  ],
  [
    "uniqueness",
    `DROP INDEX studio_run_catalog_current;
     CREATE INDEX studio_run_catalog_current
       ON studio_run_catalog_versions(run_id)
       WHERE valid_to_epoch IS NULL;`
  ],
  [
    "partial predicate",
    `DROP INDEX studio_run_catalog_retention;
     CREATE INDEX studio_run_catalog_retention
       ON studio_run_catalog_versions(valid_to_at_ms)
       WHERE valid_to_at_ms IS NULL;`
  ],
  [
    "presence",
    "DROP INDEX studio_run_catalog_job;"
  ]
] as const;

async function initializeVersionOneDatabase(filePath: string): Promise<void> {
  const store = await createSqliteRunStore({ filePath });
  store.close();
}

function rewriteSchemaObject(
  filePath: string,
  objectName: string,
  expectedFragment: string,
  replacementFragment: string
): void {
  const database = new DatabaseSync(filePath);
  try {
    const row = database.prepare(`
      SELECT sql FROM sqlite_schema WHERE name = ?
    `).get(objectName) as { sql: string } | undefined;
    if (row === undefined || !row.sql.includes(expectedFragment)) {
      throw new Error(`Test schema fixture ${objectName} did not match its expected DDL`);
    }
    const version = database.prepare("PRAGMA schema_version").get() as {
      schema_version: number;
    };
    database.exec("PRAGMA writable_schema = ON");
    try {
      database.prepare("UPDATE sqlite_schema SET sql = ? WHERE name = ?")
        .run(row.sql.replace(expectedFragment, replacementFragment), objectName);
      database.exec(`PRAGMA schema_version = ${version.schema_version + 1}`);
    } finally {
      database.exec("PRAGMA writable_schema = OFF");
    }
  } finally {
    database.close();
  }
}

async function expectCorruptSchema(filePath: string): Promise<void> {
  await expect(createSqliteRunStore({ filePath })).rejects.toMatchObject({
    code: "run_store_corrupt"
  });
}

describe("SQLite run store migrations", () => {
  it("rejects a pre-existing symbolic-link database leaf", async () => {
    await withDatabasePath(async ({ root, filePath }) => {
      const outside = path.join(root, "outside.sqlite");
      await writeFile(outside, "untouched", "utf8");
      await symlink(outside, filePath);

      await expect(createSqliteRunStore({ filePath })).rejects.toMatchObject({
        code: "run_store_io_failed"
      });
      await expect(readFile(outside, "utf8")).resolves.toBe("untouched");
    });
  });

  it("creates a durable WAL schema and preserves records across reopen", async () => {
    await withRunStore(async ({ filePath, store }) => {
      await store.ledger.preallocate(preallocation("run-1"));
      store.close();

      const reopened = await createSqliteRunStore({ filePath });
      try {
        expect((await reopened.ledger.get("run-1"))?.dispatch_status).toBe("queued");
        const database = new DatabaseSync(filePath, { readOnly: true });
        try {
          const version = database.prepare("PRAGMA user_version").get() as {
            user_version: number;
          };
          const journal = database.prepare("PRAGMA journal_mode").get() as {
            journal_mode: string;
          };
          expect(version.user_version).toBe(1);
          expect(journal.journal_mode).toBe("wal");
        } finally {
          database.close();
        }
        if (process.platform !== "win32") {
          expect((await stat(filePath)).mode & 0o777).toBe(0o600);
        }
      } finally {
        reopened.close();
      }
    });
  });

  it("rejects partial, falsely versioned, and future schemas explicitly", async () => {
    await withDatabasePath(async ({ filePath }) => {
      const database = new DatabaseSync(filePath);
      database.exec("CREATE TABLE studio_run_partial (id TEXT)");
      database.close();
      await expect(createSqliteRunStore({ filePath })).rejects.toMatchObject({
        code: "run_store_corrupt"
      });
    });

    await withDatabasePath(async ({ filePath }) => {
      const database = new DatabaseSync(filePath);
      database.exec("PRAGMA user_version = 1");
      database.close();
      await expect(createSqliteRunStore({ filePath })).rejects.toMatchObject({
        code: "run_store_corrupt"
      });
    });

    await withDatabasePath(async ({ filePath }) => {
      const database = new DatabaseSync(filePath);
      database.exec("PRAGMA user_version = 999");
      database.close();
      await expect(createSqliteRunStore({ filePath })).rejects.toMatchObject({
        code: "run_store_schema_unsupported",
        details: { schema_version: 999, supported_version: 1 }
      });
    });
  });

  it.each(TABLE_SCHEMA_TAMPERING)(
    "rejects a falsely versioned schema with an altered %s contract",
    async (_contract, objectName, expectedFragment, replacementFragment) => {
      await withDatabasePath(async ({ filePath }) => {
        await initializeVersionOneDatabase(filePath);
        rewriteSchemaObject(filePath, objectName, expectedFragment, replacementFragment);
        await expectCorruptSchema(filePath);
      });
    }
  );

  it.each(INDEX_SCHEMA_TAMPERING)(
    "rejects a falsely versioned schema with altered index %s",
    async (_contract, tamperingSql) => {
      await withDatabasePath(async ({ filePath }) => {
        await initializeVersionOneDatabase(filePath);
        const database = new DatabaseSync(filePath);
        try {
          database.exec(tamperingSql);
        } finally {
          database.close();
        }
        await expectCorruptSchema(filePath);
      });
    }
  );

  it("imports partial and legacy records through a distinct reconciler port", async () => {
    await withRunStore(async ({ store }) => {
      const complete = initialRunRecord(preallocation("legacy-run"));
      const {
        workflow_revision: _workflowRevision,
        definition_bundle_hash: _bundleHash,
        catalog_fingerprint: _catalogFingerprint,
        execution_snapshot_hash: _snapshotHash,
        graph_snapshot_handle: _graphSnapshot,
        dispatch_status: _dispatchStatus,
        artifact_count: _artifactCount,
        interrupt_count: _interruptCount,
        lifecycle_projection: _lifecycleProjection,
        ...base
      } = complete;
      const legacy = {
        ...base,
        dispatch_status: "historical_unknown" as const,
        lifecycle_projection: "unknown" as const,
        completeness: "legacy" as const
      };

      const first = await store.reconciler.importHistorical({
        record: legacy,
        transition_id: "import-legacy-run",
        event_id: "event-import-legacy-run"
      });
      const retry = await store.reconciler.importHistorical({
        record: legacy,
        transition_id: "import-legacy-run",
        event_id: "event-import-legacy-run"
      });
      expect(first.applied).toBe(true);
      expect(retry.applied).toBe(false);
      const item = await store.catalog.get("legacy-run");
      expect(item?.record.completeness).toBe("legacy");
      expect(item?.record.dispatch_status).toBe("historical_unknown");
      expect(item?.record.lifecycle_projection).toBe("unknown");
      expect(item?.record).not.toHaveProperty("graph_snapshot_handle");
      expect(item?.record).not.toHaveProperty("artifact_count");
      expect(item?.record).not.toHaveProperty("interrupt_count");
    });
  });

  it("keeps storage failures generic instead of exposing host paths", async () => {
    await withDatabasePath(async ({ root }) => {
      const error = await createSqliteRunStore({ filePath: root }).catch(
        (cause: unknown) => cause
      );
      expect(error).toMatchObject({ code: "run_store_io_failed" });
      expect(String(error)).not.toContain(root);
    });
  });

  it("detects corrupted persisted records without leaking the database path", async () => {
    await withDatabasePath(async ({ filePath }) => {
      const store = await createSqliteRunStore({ filePath });
      await store.ledger.preallocate(preallocation("run-corrupt"));
      store.close();

      const database = new DatabaseSync(filePath);
      database.prepare("UPDATE studio_runs SET record_json = ? WHERE run_id = ?")
        .run("{not-json", "run-corrupt");
      database.close();

      const reopened = await createSqliteRunStore({ filePath });
      try {
        const error = await reopened.ledger.get("run-corrupt").catch(
          (cause: unknown) => cause
        );
        expect(error).toMatchObject({ code: "run_store_corrupt" });
        expect(String(error)).not.toContain(filePath);
      } finally {
        reopened.close();
      }
    });
  });
});
