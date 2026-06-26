import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFilesystemArtifactContentStore,
  createFilesystemArtifactManifestStore
} from "../../../src/runtime/backends/filesystem/artifacts.js";
import {
  publishArtifactTransaction
} from "../../../src/core/runtime/artifacts/transaction.js";
import { createFilesystemEventStore } from "../../../src/runtime/backends/filesystem/events.js";
import { createFilesystemRuntimeLogStore } from "../../../src/runtime/backends/filesystem/runtime-log.js";

describe("filesystem runtime backends", () => {
  it("writes artifact manifests, events, and runtime logs under configured roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));

    try {
      const artifacts = createFilesystemArtifactManifestStore({
        root: path.join(root, "artifacts")
      });
      const events = createFilesystemEventStore({
        root: path.join(root, "events")
      });
      const logs = createFilesystemRuntimeLogStore({
        root: path.join(root, "logs")
      });

      await artifacts.put({
        id: "manifest-1",
        run_id: "run-1",
        uri: "artifact://run-1/report.json",
        source_node_id: "report",
        artifact_path: "report.json",
        attempt: 1,
        backend_id: "filesystem.artifacts",
        backend_root: "artifacts",
        created_at: "2026-06-25T00:00:00.000Z"
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

      await expect(
        artifacts.get({
          id: "manifest-1",
          run_id: "run-1",
          source_node_id: "report",
          artifact_path: "report.json",
          attempt: 1,
          backend_id: "filesystem.artifacts",
          backend_root: "artifacts"
        })
      ).resolves.toMatchObject({
        id: "manifest-1"
      });
      await expect(events.list("run-1")).resolves.toMatchObject([
        { id: "event-1", sequence: 1 }
      ]);
      await expect(
        events.query({ runId: "run-1", nodeId: "writer" })
      ).resolves.toMatchObject([{ id: "event-1" }]);
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

  it("writes and commits artifact content through the filesystem content port", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));
    const content = createFilesystemArtifactContentStore({ root });

    try {
      const write = await content.write({
        transaction_id: "run-1/writer/artifact-1",
        run_id: "run-1",
        node_id: "writer",
        artifact_id: "artifact-1",
        artifact_path: "reports/result.json",
        content: "{\"ok\":true}\n",
        content_hash:
          "sha256:48f84d42502f3038dd8c842c4d79f4d0bd73db70f5910b2f914f7fd8043e4693"
      });

      await expect(
        content.commit({
          transaction_id: "run-1/writer/artifact-1",
          run_id: "run-1",
          node_id: "writer",
          artifact_id: "artifact-1",
          artifact_path: "reports/result.json",
          pending_uri: write.pending_uri,
          content_hash: requiredContentHash(write.content_hash),
          overwrite_policy: "forbid"
        })
      ).resolves.toMatchObject({
        uri: "artifact://run-1/reports/result.json",
        content_hash: requiredContentHash(write.content_hash)
      });

      await expect(
        readFile(path.join(root, "run-1", "reports", "result.json"), "utf8")
      ).resolves.toBe("{\"ok\":true}\n");
      await expect(
        content.commit({
          transaction_id: "run-1/writer/artifact-1",
          run_id: "run-1",
          node_id: "writer",
          artifact_id: "artifact-1",
          artifact_path: "reports/result.json",
          pending_uri: write.pending_uri,
          content_hash: requiredContentHash(write.content_hash),
          overwrite_policy: "forbid"
        })
      ).resolves.toMatchObject({
        uri: "artifact://run-1/reports/result.json"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps manifest lookup scoped by the exact structured key", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));
    const artifacts = createFilesystemArtifactManifestStore({ root });

    try {
      const base = {
        id: "manifest-1",
        run_id: "run-1",
        source_node_id: "writer",
        attempt: 1,
        backend_id: "filesystem.artifacts",
        backend_root: "artifacts",
        created_at: "2026-06-25T00:00:00.000Z"
      };
      await artifacts.put({
        ...base,
        uri: "artifact://run-1/reports/result.json",
        artifact_path: "reports/result.json"
      });
      await artifacts.put({
        ...base,
        uri: "artifact://run-1/reports-result.json",
        artifact_path: "reports-result.json"
      });

      await expect(
        artifacts.get({
          id: "manifest-1",
          run_id: "run-1",
          source_node_id: "writer",
          artifact_path: "reports/result.json",
          attempt: 1,
          backend_id: "filesystem.artifacts",
          backend_root: "artifacts"
        })
      ).resolves.toMatchObject({ uri: "artifact://run-1/reports/result.json" });
      await expect(
        artifacts.get({
          id: "manifest-1",
          run_id: "run-1",
          source_node_id: "writer",
          artifact_path: "reports-result.json",
          attempt: 1,
          backend_id: "filesystem.artifacts",
          backend_root: "artifacts"
        })
      ).resolves.toMatchObject({ uri: "artifact://run-1/reports-result.json" });
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

  it("rejects unsafe artifact content paths and conflicting commits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));
    const content = createFilesystemArtifactContentStore({ root });

    try {
      await expect(
        content.write({
          transaction_id: "run-1/writer/artifact-1",
          run_id: "run-1",
          node_id: "writer",
          artifact_id: "artifact-1",
          artifact_path: "../escape.json",
          content: "escape",
          content_hash: "sha256:unused"
        })
      ).rejects.toMatchObject({ code: "path_security_violation" });

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

  it("rejects unsupported version overwrite before filesystem commit", async () => {
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
          pending_uri: write.pending_uri,
          content_hash: requiredContentHash(write.content_hash),
          overwrite_policy: "version"
        })
      ).rejects.toMatchObject({ code: "artifact_overwrite_policy_unsupported" });
      await expect(
        readFile(path.join(root, "run-1", "result.json"), "utf8")
      ).rejects.toMatchObject({ code: "ENOENT" });
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
      const [pendingFile] = await readdir(path.join(root, "run-1", ".pending"));
      if (pendingFile === undefined) {
        throw new Error("Expected pending artifact file.");
      }
      await writeFile(path.join(root, "run-1", ".pending", pendingFile), "tampered");

      await expect(
        content.commit({
          transaction_id: "run-1/writer/artifact-1",
          run_id: "run-1",
          node_id: "writer",
          artifact_id: "artifact-1",
          artifact_path: "result.json",
          pending_uri: write.pending_uri,
          content_hash: requiredContentHash(write.content_hash),
          overwrite_policy: "forbid"
        })
      ).rejects.toMatchObject({ code: "artifact_pending_content_invalid" });
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
      for (const artifactPath of [".manifests/result.json", ".pending/blob"]) {
        await expect(
          content.write({
            transaction_id: `run-1/writer/${artifactPath}`,
            run_id: "run-1",
            node_id: "writer",
            artifact_id: "artifact-1",
            artifact_path: artifactPath,
            content: "payload",
            content_hash: "sha256:unused"
          })
        ).rejects.toMatchObject({ code: "path_security_violation" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects reserved payload paths before publishing pending manifests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-fs-backends-"));
    const artifacts = createFilesystemArtifactManifestStore({
      root: path.join(root, "artifacts")
    });
    const content = createFilesystemArtifactContentStore({
      root: path.join(root, "artifacts")
    });

    try {
      await expect(
        publishArtifactTransaction({
          run_id: "run-1",
          node_id: "writer",
          artifact_id: "artifact-1",
          artifact_path: ".manifests/result.json",
          content: "payload",
          overwrite_policy: "forbid",
          backend: { id: "filesystem.artifacts", root: path.join(root, "artifacts") },
          manifestStore: artifacts,
          transactionJournal: {
            async get() {
              return undefined;
            },
            async put() {
              throw new Error("transaction journal should not be written");
            }
          },
          contentStore: content,
          stepsPublisher: {
            async publishArtifactRef() {
              throw new Error("steps should not publish");
            }
          },
          checkpointMarker: {
            async markArtifactCheckpointed() {
              throw new Error("checkpoint should not publish");
            }
          }
        })
      ).rejects.toMatchObject({ code: "path_security_violation" });

      await expect(artifacts.list("run-1")).resolves.toEqual([]);
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
