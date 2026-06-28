import { describe, expect, it } from "vitest";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";

describe("memory runtime backends", () => {
  it("keys artifact manifests by structured identity without slash collisions", async () => {
    const store = createMemoryArtifactManifestStore();
    await store.put({
      id: "artifact-1",
      run_id: "run-1",
      uri: "memory://one",
      source_node_id: "a/b",
      artifact_path: "c",
      attempt: 1,
      backend_id: "memory.artifacts",
      backend_root: "root",
      created_at: "2026-06-25T00:00:00.000Z"
    });
    await store.put({
      id: "artifact-1",
      run_id: "run-1",
      uri: "memory://two",
      source_node_id: "a",
      artifact_path: "b/c",
      attempt: 1,
      backend_id: "memory.artifacts",
      backend_root: "root",
      created_at: "2026-06-25T00:00:00.000Z"
    });

    await expect(
      store.get({
        id: "artifact-1",
        run_id: "run-1",
        source_node_id: "a/b",
        artifact_path: "c",
        attempt: 1,
        backend_id: "memory.artifacts",
        backend_root: "root"
      })
    ).resolves.toMatchObject({ uri: "memory://one" });
    await expect(
      store.get({
        id: "artifact-1",
        run_id: "run-1",
        source_node_id: "a",
        artifact_path: "b/c",
        attempt: 1,
        backend_id: "memory.artifacts",
        backend_root: "root"
      })
    ).resolves.toMatchObject({ uri: "memory://two" });
  });

  it("serializes resume attempts for interrupts", async () => {
    const store = createMemoryInterruptStore();
    await store.create({
      id: "interrupt-1",
      run_id: "run-1",
      thread_id: "thread-1",
      checkpoint_id: "checkpoint-1",
      status: "pending",
      created_at: "2026-06-25T00:00:00.000Z",
      updated_at: "2026-06-25T00:00:00.000Z"
    });
    const resumeInput = {
      interrupt_id: "interrupt-1",
      thread_id: "thread-1",
      checkpoint_id: "checkpoint-1",
      decision: "approve"
    };

    const claim = await store.beginResume("interrupt-1", "resume-1", resumeInput);
    expect(claim).toEqual({
      interrupt_id: "interrupt-1",
      resume_attempt: "resume-1",
      status: "claimed"
    });
    if (claim.status !== "claimed") {
      throw new Error("Expected first resume to claim the interrupt.");
    }
    await expect(
      store.beginResume("interrupt-1", "resume-2", {
        ...resumeInput,
        decision: "reject"
      })
    ).rejects.toMatchObject({ code: "interrupt_conflict" });

    await store.completeResume("interrupt-1", claim, "resolved", {
      interrupt_id: "interrupt-1",
      resume_id: "resume-1",
      input: resumeInput,
      decision: "approve",
      created_at: "2026-06-25T00:00:01.000Z"
    });
    await expect(
      store.beginResume("interrupt-1", "resume-2", resumeInput)
    ).resolves.toMatchObject({
      status: "duplicate",
      resume: { resume_id: "resume-1", decision: "approve" }
    });
    await expect(store.get("interrupt-1")).resolves.toMatchObject({
      status: "resolved",
      resume_attempt: "resume-1"
    });
  });

});
