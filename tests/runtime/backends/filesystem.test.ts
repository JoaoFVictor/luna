import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFilesystemArtifactContentStore,
  createFilesystemArtifactManifestStore
} from "../../../src/runtime/backends/filesystem/artifacts.js";
import { createFilesystemEventStore } from "../../../src/runtime/backends/filesystem/events.js";
import { createFilesystemInterruptStore } from "../../../src/runtime/backends/filesystem/interrupts.js";
import { createFilesystemRuntimeLogStore } from "../../../src/runtime/backends/filesystem/runtime-log.js";

describe("filesystem runtime backends", () => {
  it("writes events and runtime logs under configured roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));

    try {
      const events = createFilesystemEventStore({
        root: path.join(root, "events")
      });
      const logs = createFilesystemRuntimeLogStore({
        root: path.join(root, "logs")
      });

      await events.append({
        id: "event-1",
        run_id: "run-1",
        type: "luna.run.started",
        timestamp: "2026-06-25T00:00:00.000Z",
        node_id: "writer"
      });
      await logs.append({
        run_id: "run-1",
        timestamp: "2026-06-25T00:00:00.000Z",
        message: "runtime started"
      });

      await expect(events.list("run-1")).resolves.toMatchObject([
        { id: "event-1", sequence: 1 }
      ]);
      await expect(logs.list("run-1")).resolves.toMatchObject([
        { message: "runtime started", sequence: 1 }
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe paths through configured root sandboxing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));
    const events = createFilesystemEventStore({ root });

    try {
      await expect(
        events.append({
          id: "event-1",
          run_id: "../outside",
          type: "luna.run.started",
          timestamp: "2026-06-25T00:00:00.000Z"
        })
      ).rejects.toMatchObject({ code: "path_security_violation" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps filesystem manifests isolated from artifact payload json files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));
    const artifacts = createFilesystemArtifactManifestStore({ root });
    const content = createFilesystemArtifactContentStore({ root });

    try {
      await artifacts.put({
        id: "manifest-1",
        run_id: "run-1",
        uri: "artifact://run-1/result.json",
        source_node_id: "writer",
        artifact_path: "result.json",
        attempt: 1,
        backend_id: "filesystem.artifacts",
        backend_root: "artifacts",
        created_at: "2026-06-25T00:00:00.000Z"
      });
      const write = await content.write({
        transaction_id: "run-1/writer/artifact-1",
        run_id: "run-1",
        node_id: "writer",
        artifact_id: "artifact-1",
        artifact_path: "result.json",
        content: "{\"payload\":true}\n",
        content_hash: "sha256:unused"
      });
      await content.commit({
        transaction_id: "run-1/writer/artifact-1",
        run_id: "run-1",
        node_id: "writer",
        artifact_id: "artifact-1",
        artifact_path: "result.json",
        pending_uri: write.pending_uri,
        content_hash: requiredContentHash(write.content_hash),
        overwrite_policy: "replace"
      });

      await expect(artifacts.list("run-1")).resolves.toMatchObject([
        { id: "manifest-1" }
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects conflicting artifact content commits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));
    const content = createFilesystemArtifactContentStore({ root });

    try {
      const first = await content.write({
        transaction_id: "run-1/writer/artifact-1",
        run_id: "run-1",
        node_id: "writer",
        artifact_id: "artifact-1",
        artifact_path: "result.json",
        content: "first",
        content_hash: "sha256:unused"
      });
      await content.commit({
        transaction_id: "run-1/writer/artifact-1",
        run_id: "run-1",
        node_id: "writer",
        artifact_id: "artifact-1",
        artifact_path: "result.json",
        pending_uri: first.pending_uri,
        content_hash: requiredContentHash(first.content_hash),
        overwrite_policy: "forbid"
      });

      const second = await content.write({
        transaction_id: "run-1/writer/artifact-2",
        run_id: "run-1",
        node_id: "writer",
        artifact_id: "artifact-2",
        artifact_path: "result.json",
        content: "second",
        content_hash: "sha256:unused"
      });
      await expect(
        content.commit({
          transaction_id: "run-1/writer/artifact-2",
          run_id: "run-1",
          node_id: "writer",
          artifact_id: "artifact-2",
          artifact_path: "result.json",
          pending_uri: second.pending_uri,
          content_hash: requiredContentHash(second.content_hash),
          overwrite_policy: "forbid"
        })
      ).rejects.toMatchObject({ code: "artifact_content_conflict" });

    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects tampered pending content before filesystem commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));
    const content = createFilesystemArtifactContentStore({ root });

    try {
      const write = await content.write({
        transaction_id: "run-1/writer/artifact-1",
        run_id: "run-1",
        node_id: "writer",
        artifact_id: "artifact-1",
        artifact_path: "result.json",
        content: "first",
        content_hash: "sha256:unused"
      });
      await expect(
        content.commit({
          transaction_id: "run-1/writer/artifact-1",
          run_id: "run-1",
          node_id: "writer",
          artifact_id: "artifact-1",
          artifact_path: "result.json",
          pending_uri: "filesystem-pending://wrong",
          content_hash: requiredContentHash(write.content_hash),
          overwrite_policy: "forbid"
        })
      ).rejects.toMatchObject({ code: "artifact_pending_content_invalid" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects artifact payload paths under reserved filesystem metadata directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));
    const content = createFilesystemArtifactContentStore({ root });

    try {
      await expect(
        content.write({
          transaction_id: "run-1/writer/manifest",
          run_id: "run-1",
          node_id: "writer",
          artifact_id: "artifact-1",
          artifact_path: ".manifests/result.json",
          content: "payload",
          content_hash: "sha256:unused"
        })
      ).rejects.toMatchObject({ code: "path_security_violation" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an in-progress interrupt resume after store restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));
    const resumeInput = {
      interrupt_id: "interrupt-1",
      thread_id: "run-1",
      checkpoint_id: "checkpoint-1",
      decision: { approved: true }
    };

    try {
      const first = createFilesystemInterruptStore({ root });
      await first.create({
        id: "interrupt-1",
        run_id: "run-1",
        thread_id: "run-1",
        checkpoint_id: "checkpoint-1",
        node_id: "approval",
        status: "pending",
        created_at: "2026-06-28T00:00:00.000Z",
        updated_at: "2026-06-28T00:00:00.000Z"
      });
      await first.beginResume("interrupt-1", "resume-1", resumeInput);

      const restarted = createFilesystemInterruptStore({ root });
      await expect(
        restarted.beginResume("interrupt-1", "resume-ignored", resumeInput)
      ).resolves.toMatchObject({
        status: "claimed",
        resume_attempt: "resume-1"
      });
      await restarted.completeResume(
        "interrupt-1",
        {
          interrupt_id: "interrupt-1",
          resume_attempt: "resume-1",
          status: "claimed"
        },
        "resolved",
        {
          interrupt_id: "interrupt-1",
          resume_id: "resume-1",
          input: resumeInput,
          decision: resumeInput.decision,
          created_at: "2026-06-28T00:00:01.000Z"
        }
      );

      await expect(restarted.get("interrupt-1")).resolves.toMatchObject({
        status: "resolved",
        resume: { resume_id: "resume-1" }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});

function requiredContentHash(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("Expected filesystem content backend to return content_hash.");
  }
  return value;
}
