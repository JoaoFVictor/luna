import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckpointStore } from "../../../src/core/runtime/backends/contracts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import {
  createSqliteCheckpointStore,
  sqliteCheckpointFile
} from "../../../src/runtime/backends/sqlite/checkpoints.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, {
      recursive: true,
      force: true
    }))
  );
});

async function stores(): Promise<readonly [string, CheckpointStore][]> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-write-immutability-"));
  roots.push(root);
  return [
    ["memory", createMemoryCheckpointStore()],
    ["sqlite", createSqliteCheckpointStore({ filePath: sqliteCheckpointFile(root) })]
  ];
}

const write = {
  thread_id: "run-immutable-write",
  checkpoint_ns: "",
  checkpoint_id: "node-output",
  task_id: "publish",
  index: 0,
  channel: "steps",
  value: { accepted: true, external_id: "review-42" }
} as const;

describe("checkpoint write immutability", () => {
  it("treats the exact same write as an idempotent replay", async () => {
    for (const [_name, store] of await stores()) {
      await store.saveWrites([write]);
      await store.saveWrites([structuredClone(write)]);
      await expect(store.listWrites(
        write.thread_id,
        write.checkpoint_ns,
        write.checkpoint_id
      )).resolves.toEqual([write]);
    }
  });

  it("rejects a different value or channel for the same immutable identity", async () => {
    for (const [_name, store] of await stores()) {
      await store.saveWrites([write]);
      await expect(store.saveWrites([{
        ...write,
        value: { accepted: false, external_id: "review-99" }
      }])).rejects.toMatchObject({ code: "runtime_duplicate_node_output" });
      await expect(store.saveWrites([{
        ...write,
        channel: "different-channel"
      }])).rejects.toMatchObject({ code: "runtime_duplicate_node_output" });
      await expect(store.listWrites(
        write.thread_id,
        write.checkpoint_ns,
        write.checkpoint_id
      )).resolves.toEqual([write]);
    }
  });

  it("detects writes for a thread across checkpoint ids and namespaces", async () => {
    for (const [_name, store] of await stores()) {
      const second = {
        ...write,
        checkpoint_ns: "legacy",
        checkpoint_id: "removed-node-output",
        task_id: "removed_node",
        index: 1
      };
      await store.saveWrites([
        write,
        second,
        { ...write, thread_id: "different-run" }
      ]);

      await expect(store.hasThreadWrites(write.thread_id)).resolves.toBe(true);
      await expect(store.hasThreadWrites("missing-run")).resolves.toBe(false);
    }
  });
});
