import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ARTIFACT_MANIFEST_LIST_LIMIT_MAXIMA } from "../../../src/core/runtime/artifacts/contracts.js";
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

  it("enforces manifest count and per-file byte limits at list origin", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));
    const artifacts = createFilesystemArtifactManifestStore({ root });

    try {
      for (const id of ["one", "two"]) {
        await artifacts.put({
          id,
          run_id: "run-count",
          uri: `artifact://run-count/${id}.json`,
          artifact_path: `${id}.json`,
          created_at: "2026-06-25T00:00:00.000Z"
        });
      }
      await expect(artifacts.list("run-count", {
        max_entries: 1,
        max_entry_bytes: 4_096,
        max_total_bytes: 8_192,
        max_scanned_entries: 3
      })).rejects.toMatchObject({
        code: "artifact_manifest_list_limit_exceeded",
        kind: "entries",
        maximum: 1
      });

      await artifacts.put({
        id: "oversized",
        run_id: "run-entry-bytes",
        uri: `artifact://run-entry-bytes/${"x".repeat(1_024)}`,
        artifact_path: "oversized.json",
        created_at: "2026-06-25T00:00:00.000Z"
      });
      await expect(artifacts.list("run-entry-bytes", {
        max_entries: 2,
        max_entry_bytes: 256,
        max_total_bytes: 4_096,
        max_scanned_entries: 2
      })).rejects.toMatchObject({
        code: "artifact_manifest_list_limit_exceeded",
        kind: "entry_bytes",
        maximum: 256
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces aggregate bytes and directory iteration while listing manifests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));
    const artifacts = createFilesystemArtifactManifestStore({ root });

    try {
      for (const id of ["one", "two"]) {
        await artifacts.put({
          id,
          run_id: "run-total",
          uri: `artifact://run-total/${id}.json`,
          artifact_path: `${id}.json`,
          created_at: "2026-06-25T00:00:00.000Z"
        });
      }
      const manifestRoot = path.join(root, "run-total", ".manifests");
      const manifestFiles = await readdir(manifestRoot);
      const sizes = await Promise.all(
        manifestFiles.map(async (file) => (await stat(path.join(manifestRoot, file))).size)
      );
      const maxEntryBytes = Math.max(...sizes);
      const totalBytes = sizes.reduce((total, size) => total + size, 0);
      await expect(artifacts.list("run-total", {
        max_entries: 2,
        max_entry_bytes: maxEntryBytes,
        max_total_bytes: totalBytes - 1,
        max_scanned_entries: 2
      })).rejects.toMatchObject({
        code: "artifact_manifest_list_limit_exceeded",
        kind: "total_bytes",
        maximum: totalBytes - 1
      });

      const junkRoot = path.join(root, "run-scan", ".manifests");
      await mkdir(junkRoot, { recursive: true });
      await Promise.all([
        writeFile(path.join(junkRoot, "junk-a"), "x"),
        writeFile(path.join(junkRoot, "junk-b"), "x"),
        writeFile(path.join(junkRoot, "junk-c"), "x")
      ]);
      await expect(artifacts.list("run-scan", {
        max_entries: 1,
        max_entry_bytes: 256,
        max_total_bytes: 256,
        max_scanned_entries: 2
      })).rejects.toMatchObject({
        code: "artifact_manifest_list_limit_exceeded",
        kind: "scanned_entries",
        maximum: 2
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects manifest list configuration above absolute safety ceilings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));
    const artifacts = createFilesystemArtifactManifestStore({ root });

    try {
      await expect(artifacts.list("run-limit-config", {
        max_entries: ARTIFACT_MANIFEST_LIST_LIMIT_MAXIMA.max_entries + 1
      })).rejects.toThrow(/max_entries.*no greater/);
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

  it.each([
    ".manifests/result.json",
    ".MaNiFeStS/result.json",
    ".pending/result.json",
    ".PENDING/result.json",
    "events.jsonl",
    "EVENTS.JSONL",
    "runtime.log.jsonl",
    "Runtime.Log.Jsonl",
    "runtime.log.jsonl/nested/payload.json",
    "EVENTS.JSONL/nested/payload.json",
    "trace.jsonl",
    "TRACE.JSONL",
    "trace.jsonl/nested/payload.json"
  ])("rejects artifact payload paths under reserved run storage: %s", async (artifactPath) => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));
    const content = createFilesystemArtifactContentStore({ root });

    try {
      await expect(
        content.write({
          transaction_id: "run-1/writer/manifest",
          run_id: "run-1",
          node_id: "writer",
          artifact_id: "artifact-1",
          artifact_path: artifactPath,
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
