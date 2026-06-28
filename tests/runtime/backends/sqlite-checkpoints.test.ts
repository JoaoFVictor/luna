import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSqliteCheckpointStore,
  sqliteCheckpointFile
} from "../../../src/runtime/backends/sqlite/checkpoints.js";

describe("sqlite durable checkpoint backend", () => {
  it("persists checkpoints across store instances by thread_id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-checkpoints-"));
    const filePath = sqliteCheckpointFile(root);

    try {
      await mkdir(root, { recursive: true });
      const firstStore = createSqliteCheckpointStore({ filePath });
      await firstStore.save({
        thread_id: "thread-1",
        checkpoint_id: "checkpoint-1",
        state_schema_version: "2026-06",
        state: {
          state_schema_version: "2026-06",
          interrupt_refs: [{ id: "interrupt-1", uri: "interrupt://run-1/1" }]
        },
        created_at: "2026-06-25T00:00:00.000Z"
      });

      const secondStore = createSqliteCheckpointStore({ filePath });
      await expect(secondStore.load("thread-1")).resolves.toMatchObject({
        thread_id: "thread-1",
        checkpoint_id: "checkpoint-1",
        revision: 1
      });

      await secondStore.save({
        thread_id: "thread-1",
        checkpoint_id: "checkpoint-2",
        state_schema_version: "2026-06",
        state: {
          state_schema_version: "2026-06",
          event_cursor: "2"
        }
      });
      await expect(secondStore.list("thread-1")).resolves.toMatchObject([
        { checkpoint_id: "checkpoint-2", revision: 2 },
        { checkpoint_id: "checkpoint-1", revision: 1 }
      ]);
      await expect(
        secondStore.list("thread-1", { beforeCheckpointId: "checkpoint-2" })
      ).resolves.toMatchObject([{ checkpoint_id: "checkpoint-1" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects incompatible state schema resume", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-checkpoints-"));
    const store = createSqliteCheckpointStore({
      filePath: sqliteCheckpointFile(root)
    });

    try {
      await mkdir(root, { recursive: true });
      await store.save({
        thread_id: "thread-1",
        checkpoint_id: "checkpoint-1",
        state_schema_version: "2026-06",
        state: {
          state_schema_version: "2026-06",
          event_cursor: "10"
        }
      });

      await expect(
        store.load("thread-1", { expectedStateSchemaVersion: "2027-01" })
      ).rejects.toMatchObject({ code: "runtime_checkpoint_schema_mismatch" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
