import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ERROR } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";
import {
  createSqliteCheckpointStore,
  sqliteCheckpointFile
} from "../../../src/runtime/backends/sqlite/checkpoints.js";
import { createLangGraphCheckpointer } from "../../../src/runtime/backends/sqlite/langgraph-checkpointer.js";

describe("LangGraph checkpointer adapter", () => {
  it("stores and returns tuples through the durable checkpoint port", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-langgraph-checkpointer-"));

    try {
      const store = createSqliteCheckpointStore({
        filePath: sqliteCheckpointFile(root)
      });
      const checkpointer = createLangGraphCheckpointer(store);

      await expect(
        checkpointer.put(
          { configurable: { thread_id: "thread-1" } },
          {
            v: 4,
            id: "checkpoint-1",
            ts: "2026-06-25T00:00:00.000Z",
            channel_values: {
              state_schema_version: "2026-06",
              event_cursor: "1"
            },
            channel_versions: { event_cursor: 1 },
            versions_seen: { writer: { event_cursor: 1 } }
          },
          {
            source: "loop",
            step: 1,
            parents: {}
          },
          {}
        )
      ).resolves.toMatchObject({
        configurable: { thread_id: "thread-1", checkpoint_id: "checkpoint-1" }
      });

      await expect(
        checkpointer.getTuple({ configurable: { thread_id: "thread-1" } })
      ).resolves.toMatchObject({
        config: {
          configurable: {
            thread_id: "thread-1",
            checkpoint_id: "checkpoint-1"
          }
        },
        checkpoint: {
          channel_values: {
            event_cursor: "1"
          }
        },
        metadata: {
          source: "loop"
        }
      });
      await checkpointer.put(
        {
          configurable: {
            thread_id: "thread-1",
            checkpoint_id: "checkpoint-1"
          }
        },
        {
          v: 4,
          id: "checkpoint-2",
          ts: "2026-06-25T00:00:01.000Z",
          channel_values: {
            state_schema_version: "2026-06",
            event_cursor: "2"
          },
          channel_versions: { event_cursor: 2 },
          versions_seen: { writer: { event_cursor: 2 } }
        },
        {
          source: "update",
          step: 2,
          parents: { "": "checkpoint-1" }
        },
        {}
      );
      await expect(
        checkpointer.getTuple({
          configurable: {
            thread_id: "thread-1",
            checkpoint_id: "checkpoint-2"
          }
        })
      ).resolves.toMatchObject({
        parentConfig: {
          configurable: {
            thread_id: "thread-1",
            checkpoint_id: "checkpoint-1"
          }
        },
        metadata: {
          source: "update",
          step: 2
        }
      });
      await checkpointer.putWrites(
        {
          configurable: {
            thread_id: "thread-1",
            checkpoint_id: "checkpoint-1"
          }
        },
        [[ERROR, "first"], [ERROR, "replacement"]],
        "task-err"
      );
      await expect(
        checkpointer.getTuple({
          configurable: {
            thread_id: "thread-1",
            checkpoint_id: "checkpoint-1"
          }
        })
      ).resolves.toMatchObject({
        pendingWrites: expect.arrayContaining([
          ["task-err", ERROR, "replacement"]
        ])
      });
      await checkpointer.put(
        {
          configurable: {
            thread_id: "thread-1",
            checkpoint_ns: "alternate"
          }
        },
        {
          v: 4,
          id: "checkpoint-1",
          ts: "2026-06-25T00:00:02.000Z",
          channel_values: {
            state_schema_version: "2026-06",
            event_cursor: "alternate"
          },
          channel_versions: { event_cursor: 1 },
          versions_seen: { writer: { event_cursor: 1 } }
        },
        {
          source: "fork",
          step: 3,
          parents: {}
        },
        {}
      );
      await checkpointer.putWrites(
        {
          configurable: {
            thread_id: "thread-1",
            checkpoint_ns: "alternate",
            checkpoint_id: "checkpoint-1"
          }
        },
        [["event_cursor", "alternate-write"]],
        "task-alt"
      );
      await expect(
        checkpointer.getTuple({
          configurable: {
            thread_id: "thread-1",
            checkpoint_ns: "alternate",
            checkpoint_id: "checkpoint-1"
          }
        })
      ).resolves.toMatchObject({
        checkpoint: {
          channel_values: {
            event_cursor: "alternate"
          }
        },
        pendingWrites: [["task-alt", "event_cursor", "alternate-write"]]
      });

    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
