import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runStudioGitRead,
  StudioGitProcessError
} from "../../../src/studio/adapters/git/read-process.js";

const execFileAsync = promisify(execFile);
let repositoryRoot: string;

beforeEach(async () => {
  repositoryRoot = await mkdtemp(path.join(tmpdir(), "luna-git-process-"));
  await execFileAsync("git", ["init", "-b", "main"], {
    cwd: repositoryRoot
  });
});

afterEach(async () => {
  await rm(repositoryRoot, { recursive: true, force: true });
});

describe("runStudioGitRead", () => {
  it("terminates a subprocess whose discarded stderr exceeds its cap", async () => {
    let caught: unknown;
    try {
      await runStudioGitRead({
        cwd: repositoryRoot,
        args: ["show", "does-not-exist"],
        timeoutMs: 2_000,
        maxStdoutBytes: 4 * 1024,
        maxStderrBytes: 1
      });
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(StudioGitProcessError);
    expect(caught).toMatchObject({ reason: "stderr_too_large" });
    expect((caught as Error).message).not.toContain("x".repeat(128));
  });

  it.skipIf(process.platform === "win32")(
    "kills an aborted process group even when the command ignores SIGTERM",
    async () => {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), 50);
      const startedAt = Date.now();
      try {
        await expect(runStudioGitRead({
          cwd: repositoryRoot,
          args: [
            "-c",
            "alias.hang=!trap '' TERM; while :; do sleep 1; done",
            "hang"
          ],
          signal: controller.signal,
          timeoutMs: 2_000
        })).rejects.toMatchObject({ reason: "aborted" });
      } finally {
        clearTimeout(abort);
      }
      expect(Date.now() - startedAt).toBeLessThan(1_500);
    }
  );
});
