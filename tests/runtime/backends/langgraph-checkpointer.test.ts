import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
      await mkdir(root, { recursive: true });
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
              artifact_refs: [{ id: "artifact-1", uri: "artifact://run-1/a.json" }]
            },
            channel_versions: { artifact_refs: 1 },
            versions_seen: { writer: { artifact_refs: 1 } }
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
            artifact_refs: [{ id: "artifact-1", uri: "artifact://run-1/a.json" }]
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
      const listed = [];
      for await (const tuple of checkpointer.list(
        { configurable: { thread_id: "thread-1" } },
        { filter: { source: "loop" } }
      )) {
        listed.push(tuple);
      }

      expect(listed).toHaveLength(1);
      const exactCheckpointList = [];
      for await (const tuple of checkpointer.list({
        configurable: { thread_id: "thread-1", checkpoint_id: "checkpoint-2" }
      })) {
        exactCheckpointList.push(tuple);
      }

      expect(exactCheckpointList).toHaveLength(1);
      expect(exactCheckpointList[0]?.checkpoint.id).toBe("checkpoint-2");

      const beforeCheckpointList = [];
      for await (const tuple of checkpointer.list(
        { configurable: { thread_id: "thread-1" } },
        {
          before: {
            configurable: {
              thread_id: "thread-1",
              checkpoint_id: "checkpoint-2"
            }
          }
        }
      )) {
        beforeCheckpointList.push(tuple);
      }

      expect(beforeCheckpointList.map((tuple) => tuple.checkpoint.id)).toEqual([
        "checkpoint-1"
      ]);

      await checkpointer.putWrites(
        {
          configurable: {
            thread_id: "thread-1",
            checkpoint_id: "checkpoint-1"
          }
        },
        [["artifact_refs", [{ id: "artifact-2", uri: "artifact://run-1/b.json" }]]],
        "task-1"
      );
      await expect(
        checkpointer.getTuple({
          configurable: {
            thread_id: "thread-1",
            checkpoint_id: "checkpoint-1"
          }
        })
      ).resolves.toMatchObject({
        pendingWrites: [
          ["task-1", "artifact_refs", [{ id: "artifact-2", uri: "artifact://run-1/b.json" }]]
        ]
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
            checkpoint_id: "checkpoint-1"
          }
        })
      ).resolves.toMatchObject({
        checkpoint: {
          channel_values: {
            artifact_refs: [{ id: "artifact-1", uri: "artifact://run-1/a.json" }]
          }
        }
      });
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

      await checkpointer.deleteThread("thread-1");
      await expect(
        checkpointer.getTuple({ configurable: { thread_id: "thread-1" } })
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-ref-only LangGraph checkpoint channel values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-langgraph-checkpointer-"));

    try {
      const checkpointer = createLangGraphCheckpointer(
        createSqliteCheckpointStore({ filePath: sqliteCheckpointFile(root) })
      );

      await expect(
        checkpointer.put(
          { configurable: { thread_id: "thread-1" } },
          {
            v: 4,
            id: "checkpoint-1",
            ts: "2026-06-25T00:00:00.000Z",
            channel_values: {
              state_schema_version: "2026-06",
              steps: { writer: { large_payload: "not allowed" } }
            },
            channel_versions: {},
            versions_seen: {}
          },
          {
            source: "loop",
            step: 1,
            parents: {}
          },
          {}
        )
      ).rejects.toMatchObject({ code: "runtime_checkpoint_not_ref_only" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
