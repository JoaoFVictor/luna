import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunLockManager } from "../../src/core/run-lock-manager.js";
import { noopRunLogger, type RunLogger } from "../../src/core/run-logger.js";

describe("run lock manager", () => {
  it("serializes exclusive access to the same resource", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    const manager = new RunLockManager({
      root,
      runId: "run-1",
      timeoutMs: 1000,
      staleAfterMs: 6000,
      logger: noopRunLogger
    });

    const release = await manager.acquire("repository:repo", "exclusive");
    await expect(
      manager.acquire("repository:repo", "exclusive", { timeoutMs: 10 })
    ).rejects.toMatchObject({ code: "lock_timeout" });
    await release();
    const secondRelease = await manager.acquire("repository:repo", "exclusive", {
      timeoutMs: 1000
    });
    expect(secondRelease).toEqual(expect.any(Function));
    await secondRelease();
  });

  it("writes lock owner metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    const manager = new RunLockManager({
      root,
      runId: "run-1",
      flueRunId: "flue-1",
      timeoutMs: 1000,
      staleAfterMs: 6000,
      logger: noopRunLogger
    });

    const release = await manager.acquire("repository:repo", "exclusive");
    const content = await readFile(
      path.join(root, "repository_repo.lock", "owner.json"),
      "utf8"
    );
    expect(JSON.parse(content)).toMatchObject({
      resource: "repository:repo",
      run_id: "run-1",
      flue_run_id: "flue-1"
    });
    await release();
  });

  it("does not steal a stale-looking lock from a live pid", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    await mkdir(path.join(root, "repository_repo.lock"), { recursive: true });
    await writeFile(
      path.join(root, "repository_repo.lock", "owner.json"),
      `${JSON.stringify({
        resource: "repository:repo",
        mode: "exclusive",
        run_id: "other-run",
        pid: process.pid,
        heartbeat_at: new Date(Date.now() - 10_000).toISOString()
      })}\n`,
      "utf8"
    );
    const manager = new RunLockManager({
      root,
      runId: "run-1",
      timeoutMs: 20,
      staleAfterMs: 3000,
      logger: noopRunLogger
    });

    await expect(
      manager.acquire("repository:repo", "exclusive", { timeoutMs: 20 })
    ).rejects.toMatchObject({ code: "lock_timeout" });
  });

  it("treats corrupt owner metadata as non-recoverable until timeout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    await mkdir(path.join(root, "repository_repo.lock"), { recursive: true });
    await writeFile(
      path.join(root, "repository_repo.lock", "owner.json"),
      "{not-json",
      "utf8"
    );
    const manager = new RunLockManager({
      root,
      runId: "run-1",
      timeoutMs: 20,
      staleAfterMs: 3000,
      logger: noopRunLogger
    });

    await expect(
      manager.acquire("repository:repo", "exclusive", { timeoutMs: 20 })
    ).rejects.toMatchObject({ code: "lock_timeout" });
  });

  it("recovers a stale lock from a dead pid", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    await mkdir(path.join(root, "repository_repo.lock"), { recursive: true });
    await writeFile(
      path.join(root, "repository_repo.lock", "owner.json"),
      `${JSON.stringify({
        resource: "repository:repo",
        mode: "exclusive",
        run_id: "other-run",
        owner_token: "other-token",
        pid: 999999999,
        heartbeat_at: new Date(Date.now() - 10_000).toISOString()
      })}\n`,
      "utf8"
    );
    const manager = new RunLockManager({
      root,
      runId: "run-1",
      timeoutMs: 1000,
      staleAfterMs: 3000,
      logger: noopRunLogger
    });

    const release = await manager.acquire("repository:repo", "exclusive");
    const content = await readFile(
      path.join(root, "repository_repo.lock", "owner.json"),
      "utf8"
    );
    expect(JSON.parse(content)).toMatchObject({ run_id: "run-1" });
    await release();
  });

  it("creates the lock root before acquiring", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "luna-lock-parent-")),
      ".luna",
      "locks"
    );
    const manager = new RunLockManager({
      root,
      runId: "run-1",
      timeoutMs: 1000,
      staleAfterMs: 3000,
      logger: noopRunLogger
    });

    const release = await manager.acquire("repository:repo", "exclusive");
    await expect(
      readFile(path.join(root, "repository_repo.lock", "owner.json"), "utf8")
    ).resolves.toContain("\"run_id\": \"run-1\"");
    await release();
  });

  it("rejects invalid lock timing", () => {
    expect(
      () =>
        new RunLockManager({
          root: "/tmp/luna-locks",
          runId: "run-1",
          timeoutMs: 0,
          staleAfterMs: 3000,
          logger: noopRunLogger
        })
    ).toThrow(expect.objectContaining({ code: "lock_config_invalid" }));
  });

  it("does not delete a replacement lock on stale release", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    const manager = new RunLockManager({
      root,
      runId: "run-1",
      timeoutMs: 1000,
      staleAfterMs: 3000,
      logger: noopRunLogger
    });

    const release = await manager.acquire("repository:repo", "exclusive");
    await rm(path.join(root, "repository_repo.lock"), {
      recursive: true,
      force: true
    });
    await mkdir(path.join(root, "repository_repo.lock"), { recursive: true });
    await writeFile(
      path.join(root, "repository_repo.lock", "owner.json"),
      `${JSON.stringify({
        resource: "repository:repo",
        mode: "exclusive",
        run_id: "replacement-run",
        owner_token: "replacement-token",
        pid: process.pid,
        heartbeat_at: new Date().toISOString()
      })}\n`,
      "utf8"
    );

    await release();

    await expect(
      readFile(path.join(root, "repository_repo.lock", "owner.json"), "utf8")
    ).resolves.toContain("replacement-run");
  });

  it("emits stable Luna lock attributes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    const logger: RunLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    };
    const events: Array<[string, Record<string, unknown> | undefined]> = [];
    logger.info = (event, attributes) => {
      events.push([event, attributes]);
    };
    const manager = new RunLockManager({
      root,
      runId: "run-1",
      flueRunId: "flue-1",
      timeoutMs: 1000,
      staleAfterMs: 3000,
      logger
    });

    const release = await manager.acquire("repository:repo", "exclusive");
    await release();

    expect(events).toContainEqual([
      "luna.lock.acquired",
      expect.objectContaining({
        "luna.run_id": "run-1",
        "luna.flue_run_id": "flue-1",
        "luna.resource": "repository:repo"
      })
    ]);
    expect(events).toContainEqual([
      "luna.lock.released",
      expect.objectContaining({
        "luna.run_id": "run-1",
        "luna.resource": "repository:repo"
      })
    ]);
  });

  it("does not let logger failures prevent acquire release or timeout behavior", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    const logger: RunLogger = {
      info: () => {
        throw new Error("logger failed");
      },
      warn: () => {
        throw new Error("logger failed");
      },
      error: () => {
        throw new Error("logger failed");
      }
    };
    const manager = new RunLockManager({
      root,
      runId: "run-1",
      timeoutMs: 20,
      staleAfterMs: 3000,
      logger
    });

    const release = await manager.acquire("repository:repo", "exclusive");
    await expect(
      manager.acquire("repository:repo", "exclusive", { timeoutMs: 20 })
    ).rejects.toMatchObject({ code: "lock_timeout" });
    await expect(release()).resolves.toBeUndefined();
  });
});
