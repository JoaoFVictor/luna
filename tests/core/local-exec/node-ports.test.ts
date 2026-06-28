import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNodeLocalExecPorts } from "../../../src/capabilities/local-exec/node-ports.js";

describe("node local-exec ports", () => {
  it("runs commands from the project root and publishes oversized output artifacts", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "luna-local-exec-"));
    const log = { info: vi.fn() };
    const ports = createNodeLocalExecPorts({
      projectRoot,
      runId: "run-1",
      log,
      stateOutputLimitBytes: 3
    });

    await expect(
      ports.commandPort.run({
        command: "pwd",
        args: []
      })
    ).resolves.toMatchObject({
      exit_code: 0,
      stdout: `${projectRoot}\n`,
      timed_out: false
    });

    const artifact = await ports.artifactPublisher.publish({
      operation_id: "local-exec.command.read",
      stream: "stdout",
      content: "abcdef",
      media_type: "text/plain"
    });
    await ports.eventSink.emit({
      type: "local-exec.output_artifact",
      operation_id: "local-exec.command.read",
      stream: "stdout",
      bytes: 6,
      artifact
    });

    await expect(
      readFile(
        path.join(
          projectRoot,
          ".luna",
          "local-exec-artifacts",
          "run-1",
          `${artifact.id}.txt`
        ),
        "utf8"
      )
    ).resolves.toBe("abcdef");
    expect(artifact.uri).toBe(`artifact://run-1/local-exec/${artifact.id}.txt`);
    expect(log.info).toHaveBeenCalledWith(
      "local-exec.output_artifact",
      expect.objectContaining({
        operation_id: "local-exec.command.read",
        artifact_id: artifact.id
      })
    );
  });

  it("keeps run ids inside the local-exec artifact root", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "luna-local-exec-"));

    for (const [runId, safeRunId] of [
      ["../escape", ".._escape"],
      ["..", "artifact"],
      [".", "artifact"]
    ] as const) {
      const ports = createNodeLocalExecPorts({ projectRoot, runId });

      const artifact = await ports.artifactPublisher.publish({
        operation_id: "local-exec.command.read",
        stream: "stdout",
        content: runId,
        media_type: "text/plain"
      });

      await expect(
        readFile(
          path.join(
            projectRoot,
            ".luna",
            "local-exec-artifacts",
            safeRunId,
            `${artifact.id}.txt`
          ),
          "utf8"
        ),
      ).resolves.toBe(runId);
      expect(artifact.uri).toBe(
        `artifact://${safeRunId}/local-exec/${artifact.id}.txt`
      );
    }

    await expect(
      readFile(path.join(projectRoot, ".luna", "escape"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects local-exec artifact roots that escape through symlinks", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "luna-local-exec-"));
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "luna-outside-"));
    await mkdir(path.join(projectRoot, ".luna"), { recursive: true });
    await symlink(
      outsideRoot,
      path.join(projectRoot, ".luna", "local-exec-artifacts")
    );
    const ports = createNodeLocalExecPorts({
      projectRoot,
      runId: "run-1"
    });

    await expect(
      ports.artifactPublisher.publish({
        operation_id: "local-exec.command.read",
        stream: "stdout",
        content: "escape",
        media_type: "text/plain"
      })
    ).rejects.toMatchObject({ code: "path_security_violation" });
    await expect(
      readFile(
        path.join(
          outsideRoot,
          "run-1",
          "local-exec.command.read-stdout-0001.txt"
        ),
        "utf8"
      )
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
