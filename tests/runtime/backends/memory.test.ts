import { describe, expect, it } from "vitest";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";

describe("memory runtime backends", () => {
  it("stores artifact manifests by run", async () => {
    const store = createMemoryArtifactManifestStore();
    await store.put({
      id: "artifact-1",
      run_id: "run-1",
      uri: "artifact://run-1/report.json",
      source_node_id: "report",
      created_at: "2026-06-25T00:00:00.000Z"
    });

    await expect(store.get("artifact-1")).resolves.toMatchObject({
      id: "artifact-1",
      run_id: "run-1"
    });
    await expect(store.list("run-1")).resolves.toHaveLength(1);
  });

  it("preserves ordered events and runtime logs", async () => {
    const events = createMemoryEventStore();
    const logs = createMemoryRuntimeLogStore();

    await events.append({
      id: "event-1",
      run_id: "run-1",
      type: "luna.run.started",
      timestamp: "2026-06-25T00:00:00.000Z",
      node_id: "writer"
    });
    await events.append({
      id: "event-2",
      run_id: "run-1",
      type: "luna.run.completed",
      timestamp: "2026-06-25T00:00:01.000Z",
      interrupt_id: "interrupt-1",
      resume_id: "resume-1"
    });
    await logs.append({
      run_id: "run-1",
      timestamp: "2026-06-25T00:00:00.000Z",
      message: "started",
      level: "info"
    });

    await expect(events.list("run-1")).resolves.toMatchObject([
      { id: "event-1", sequence: 1 },
      { id: "event-2", sequence: 2 }
    ]);
    await expect(
      events.query({ runId: "run-1", nodeId: "writer" })
    ).resolves.toMatchObject([{ id: "event-1" }]);
    await expect(
      events.query({
        runId: "run-1",
        interruptId: "interrupt-1",
        resumeId: "resume-1"
      })
    ).resolves.toMatchObject([{ id: "event-2" }]);
    await expect(logs.list("run-1")).resolves.toMatchObject([
      { message: "started", sequence: 1 }
    ]);
  });

  it("serializes resume attempts for interrupts", async () => {
    const store = createMemoryInterruptStore();
    await store.create({
      id: "interrupt-1",
      run_id: "run-1",
      status: "pending",
      created_at: "2026-06-25T00:00:00.000Z",
      updated_at: "2026-06-25T00:00:00.000Z"
    });

    await expect(store.beginResume("interrupt-1", "resume-1")).resolves.toEqual({
      interrupt_id: "interrupt-1",
      resume_attempt: "resume-1"
    });
    await expect(
      store.beginResume("interrupt-1", "resume-2")
    ).rejects.toMatchObject({ code: "runtime_interrupt_resume_in_progress" });

    await store.completeResume("interrupt-1", "resolved");
    await expect(store.get("interrupt-1")).resolves.toMatchObject({
      status: "resolved",
      resume_attempt: "resume-1"
    });
  });

  it("saves and loads ref-only checkpoints by stable thread_id", async () => {
    const store = createMemoryCheckpointStore();
    await store.save({
      thread_id: "thread-1",
      checkpoint_id: "checkpoint-1",
      state_schema_version: "2026-06",
      state: {
        state_schema_version: "2026-06",
        artifact_refs: [{ id: "artifact-1", uri: "artifact://run-1/report.json" }]
      },
      created_at: "2026-06-25T00:00:00.000Z"
    });

    await expect(store.load("thread-1")).resolves.toMatchObject({
      thread_id: "thread-1",
      checkpoint_id: "checkpoint-1",
      revision: 1
    });
    await expect(
      store.save({
        thread_id: "thread-1",
        checkpoint_id: "checkpoint-2",
        state_schema_version: "2026-06",
        state: {
          state_schema_version: "2026-06",
          steps: { writer: { output: "too much" } }
        }
      })
    ).rejects.toMatchObject({ code: "runtime_checkpoint_not_ref_only" });
  });
});
