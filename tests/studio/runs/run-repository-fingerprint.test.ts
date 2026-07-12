import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepositoryConfig } from "../../../src/core/config/schemas.js";
import { fingerprintNativeStudioRepository } from "../../../src/studio/adapters/native/run-repository-fingerprint.js";

const execFileAsync = promisify(execFile);
let repositoryRoot: string;
let repository: RepositoryConfig;

beforeEach(async () => {
  repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "luna-repository-fingerprint-")
  );
  await execFileAsync("git", ["init", "-b", "main"], {
    cwd: repositoryRoot
  });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: repositoryRoot
  });
  await execFileAsync("git", ["config", "user.name", "Luna Test"], {
    cwd: repositoryRoot
  });
  await writeFile(path.join(repositoryRoot, "tracked.txt"), "tracked\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: repositoryRoot });
  await execFileAsync("git", ["commit", "-m", "initial"], {
    cwd: repositoryRoot
  });
  repository = {
    id: "test-repository",
    provider: "github",
    owner: "luna",
    name: "test-repository",
    path: repositoryRoot,
    remote: "https://example.com/luna/test-repository.git"
  };
});

afterEach(async () => {
  await rm(repositoryRoot, { recursive: true, force: true });
});

describe("fingerprintNativeStudioRepository", () => {
  it("fingerprints regular files and symbolic links deterministically", async () => {
    await writeFile(path.join(repositoryRoot, "untracked.txt"), "content\n");
    await symlink("untracked.txt", path.join(repositoryRoot, "untracked-link"));

    const first = await fingerprintNativeStudioRepository(repository);
    const second = await fingerprintNativeStudioRepository(repository);

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second).toBe(first);

    await writeFile(path.join(repositoryRoot, "untracked.txt"), "changed\n");
    await expect(fingerprintNativeStudioRepository(repository))
      .resolves.not.toBe(first);
  });

  it.skipIf(process.platform === "win32")(
    "never opens an untracked FIFO omitted by Git's untracked-file list",
    async () => {
      const before = await fingerprintNativeStudioRepository(repository);
      await execFileAsync("mkfifo", [path.join(repositoryRoot, "pipe")]);
      const startedAt = Date.now();

      const after = await fingerprintNativeStudioRepository(repository, {
        timeoutMs: 1_000
      });

      expect(after).toBe(before);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    }
  );

  it("rejects untracked content beyond the aggregate byte budget", async () => {
    await writeFile(path.join(repositoryRoot, "first.txt"), "12345");
    await writeFile(path.join(repositoryRoot, "second.txt"), "67890");

    await expect(fingerprintNativeStudioRepository(repository, {
      maxUntrackedBytes: 9
    })).rejects.toMatchObject({
      code: "studio_run_repository_not_ready",
      details: { repository_id: "test-repository" }
    });
  });

  it("honors an already-aborted request signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(fingerprintNativeStudioRepository(repository, {
      signal: controller.signal
    })).rejects.toMatchObject({
      code: "studio_run_repository_not_ready"
    });
  });

  it("enforces one deadline across the complete fingerprint", async () => {
    await expect(fingerprintNativeStudioRepository(repository, {
      timeoutMs: 1
    })).rejects.toMatchObject({
      code: "studio_run_repository_not_ready"
    });
  });
});
