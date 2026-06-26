import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFilesystemArtifactManifestStore } from "../../../src/runtime/backends/filesystem/artifacts.js";
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

      await expect(artifacts.get("manifest-1")).resolves.toMatchObject({
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
});
