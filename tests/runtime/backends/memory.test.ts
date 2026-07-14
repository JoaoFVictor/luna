import { describe, expect, it } from "vitest";
import {
  createMemoryArtifactContentStore,
  createMemoryArtifactManifestStore
} from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";

describe("memory runtime backends", () => {
  it("rejects oversized UTF-8 content before materializing the read result", async () => {
    const store = createMemoryArtifactContentStore();
    const content = "🙂".repeat(1_024);
    const pending = await store.write({
      transaction_id: "bounded-read",
      run_id: "run-bounded",
      node_id: "image",
      artifact_id: "image",
      artifact_path: "image.txt",
      content,
      content_hash: "sha256:bounded"
    });
    await store.commit({
      transaction_id: "bounded-read",
      run_id: "run-bounded",
      node_id: "image",
      artifact_id: "image",
      artifact_path: "image.txt",
      pending_uri: pending.pending_uri,
      content_hash: "sha256:bounded",
      overwrite_policy: "forbid"
    });

    await expect(store.read?.({
      run_id: "run-bounded",
      artifact_path: "image.txt",
      max_bytes: 4_095
    })).rejects.toMatchObject({ code: "artifact_content_read_limit_exceeded" });
    await expect(store.read?.({
      run_id: "run-bounded",
      artifact_path: "image.txt",
      max_bytes: 4_096
    })).resolves.toHaveLength(4_096);
  });

  it("round-trips bounded semantic metadata and accepts legacy manifests", async () => {
    const store = createMemoryArtifactManifestStore();
    const base = {
      run_id: "run-semantic",
      uri: "memory://semantic",
      artifact_path: "result.json",
      created_at: "2026-06-25T00:00:00.000Z"
    };
    await store.put({
      ...base,
      id: "semantic",
      semantic_type: "luna.review.findings.v1"
    });
    await store.put({ ...base, id: "legacy", uri: "memory://legacy" });

    await expect(store.list("run-semantic")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "semantic",
          semantic_type: "luna.review.findings.v1"
        }),
        expect.not.objectContaining({ semantic_type: expect.anything() })
      ])
    );
    await expect(
      store.put({ ...base, id: "invalid", semantic_type: "unversioned" })
    ).rejects.toThrow();
  });

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

  it("finds a later interrupt through bounded semantic filters", async () => {
    const store = createMemoryInterruptStore();
    const record = (
      id: string,
      nodeId: string,
      createdAt: string,
      status: "pending" | "resolved"
    ) => ({
      id,
      run_id: "run-query",
      thread_id: "run-query",
      checkpoint_id: "checkpoint-query",
      node_id: nodeId,
      status,
      created_at: createdAt,
      updated_at: createdAt
    });
    await store.create(record("old", "review", "2026-07-12T12:00:00.000Z", "resolved"));
    await store.create(record("later-resolved", "review", "2026-07-12T12:01:00.000Z", "resolved"));
    await store.create(record("later-pending", "publish", "2026-07-12T12:02:00.000Z", "pending"));

    await expect(store.findFirst("run-query", {
      exclude_id: "old",
      thread_id: "run-query",
      checkpoint_id: "checkpoint-query",
      node_ids: ["review", "publish"],
      created_after: "2026-07-12T12:00:00.000Z",
      statuses: ["pending"]
    })).resolves.toMatchObject({ id: "later-pending" });
  });

});
