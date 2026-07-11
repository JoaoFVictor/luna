import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunLockManager } from "../../src/core/workflow/lock-manager.js";
import { createTelemetryBufferSink } from "../../src/core/observability/sinks.js";
import { createObservabilityRecorder } from "../../src/core/observability/tracing.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

describe("run lock manager", () => {
  it("serializes separate managers through the shared filesystem lock root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    const waitingObserved = deferred();
    const telemetry = createTelemetryBufferSink();
    const observability = createObservabilityRecorder({
      run: { id: "run-2", workflowId: "implementation", attempt: 1 },
      sinks: [telemetry]
    });
    const manager1 = new RunLockManager({
      root,
      runId: "run-1",
      timeoutMs: 1000,
      staleAfterMs: 6000
    });
    const manager2 = new RunLockManager({
      root,
      runId: "run-2",
      timeoutMs: 1000,
      staleAfterMs: 6000,
      observability
    });

    const release1 = await manager1.acquire("repository:repo", "exclusive");
    let secondAcquired = false;
    const secondAcquire = manager2
      .acquire("repository:repo", "exclusive", { timeoutMs: 1000 })
      .then((release) => {
        secondAcquired = true;
        return release;
      });

    await withTimeout(waitForLog(telemetry, "luna.lock.waiting").then(() => {
      waitingObserved.resolve();
    }), 500, "second manager did not observe repository lock contention");
    expect(secondAcquired).toBe(false);

    await release1();
    const release2 = await withTimeout(
      secondAcquire,
      1000,
      "second manager did not acquire after first release"
    );
    expect(secondAcquired).toBe(true);
    await release2();

    expect(telemetry.records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "log",
          log: expect.objectContaining({
            message: "luna.lock.waiting",
            attributes: expect.objectContaining({
              "luna.resource": "repository:repo"
            })
          })
        }),
        expect.objectContaining({
          type: "log",
          log: expect.objectContaining({
            message: "luna.lock.acquired",
            attributes: expect.objectContaining({
              "luna.resource": "repository:repo"
            })
          })
        })
      ])
    );
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
      staleAfterMs: 3000
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
      staleAfterMs: 3000
    });

    await expect(
      manager.acquire("repository:repo", "exclusive", { timeoutMs: 20 })
    ).rejects.toMatchObject({ code: "lock_timeout" });
  });

  it("recovers only an empty ownerless lock older than staleAfterMs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    const lockPath = path.join(root, "repository_repo.lock");
    await mkdir(lockPath);
    const stale = new Date(Date.now() - 10_000);
    await utimes(lockPath, stale, stale);
    const manager = new RunLockManager({
      root,
      runId: "run-1",
      timeoutMs: 1000,
      staleAfterMs: 3000
    });

    const release = await manager.acquire("repository:repo", "exclusive");
    await expect(
      readFile(path.join(lockPath, "owner.json"), "utf8")
    ).resolves.toContain('"run_id": "run-1"');
    await release();
  });

  it("recovers a stale ownerless lock left during atomic owner publication", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    const lockPath = path.join(root, "repository_repo.lock");
    await mkdir(lockPath);
    await writeFile(
      path.join(lockPath, "owner.0123456789abcdef0123456789abcdef.claim"),
      "partially prepared claim"
    );
    const stale = new Date(Date.now() - 10_000);
    await utimes(lockPath, stale, stale);
    const manager = new RunLockManager({
      root,
      runId: "run-1",
      timeoutMs: 1000,
      staleAfterMs: 3000
    });

    const release = await manager.acquire("repository:repo", "exclusive");
    await expect(
      readFile(path.join(lockPath, "owner.json"), "utf8")
    ).resolves.toContain('"run_id": "run-1"');
    await release();
  });

  it("serializes concurrent recovery of the same stale ownerless lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    const lockPath = path.join(root, "repository_repo.lock");
    await mkdir(lockPath);
    const stale = new Date(Date.now() - 10_000);
    await utimes(lockPath, stale, stale);
    const managers = ["run-1", "run-2"].map(
      (runId) =>
        new RunLockManager({
          root,
          runId,
          timeoutMs: 1000,
          staleAfterMs: 3000
        })
    );
    let acquired = 0;
    const attempts = managers.map((manager, index) =>
      manager.acquire("repository:repo", "exclusive").then((release) => {
        acquired += 1;
        return { index, release };
      })
    );

    const first = await withTimeout(
      Promise.race(attempts),
      500,
      "no manager recovered the stale ownerless lock"
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(acquired).toBe(1);
    await first.release();
    const second = await attempts[first.index === 0 ? 1 : 0]!;
    expect(acquired).toBe(2);
    await second.release();
  });

  it("does not recover a fresh or non-empty ownerless lock", async () => {
    const freshRoot = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    await mkdir(path.join(freshRoot, "repository_repo.lock"));
    const freshManager = new RunLockManager({
      root: freshRoot,
      runId: "run-1",
      timeoutMs: 20,
      staleAfterMs: 3000
    });
    await expect(
      freshManager.acquire("repository:repo", "exclusive", { timeoutMs: 20 })
    ).rejects.toMatchObject({ code: "lock_timeout" });

    const occupiedRoot = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    const occupiedLock = path.join(occupiedRoot, "repository_repo.lock");
    await mkdir(occupiedLock);
    await writeFile(path.join(occupiedLock, "claim-in-progress"), "preserve");
    const stale = new Date(Date.now() - 10_000);
    await utimes(occupiedLock, stale, stale);
    const occupiedManager = new RunLockManager({
      root: occupiedRoot,
      runId: "run-1",
      timeoutMs: 50,
      staleAfterMs: 3000
    });
    await expect(
      occupiedManager.acquire("repository:repo", "exclusive", {
        timeoutMs: 50
      })
    ).rejects.toMatchObject({ code: "lock_timeout" });
    await expect(
      readFile(path.join(occupiedLock, "claim-in-progress"), "utf8")
    ).resolves.toBe("preserve");
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
      staleAfterMs: 3000
    });

    const release = await manager.acquire("repository:repo", "exclusive");
    const content = await readFile(
      path.join(root, "repository_repo.lock", "owner.json"),
      "utf8"
    );
    expect(JSON.parse(content)).toMatchObject({ run_id: "run-1" });
    await release();
  });

  it("does not delete a replacement lock on stale release", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    const manager = new RunLockManager({
      root,
      runId: "run-1",
      timeoutMs: 1000,
      staleAfterMs: 3000
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

  it("allows a failed release to be retried without double releasing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    const manager = new RunLockManager({
      root,
      runId: "run-1",
      timeoutMs: 1000,
      staleAfterMs: 3000
    });
    const lockPath = path.join(root, "repository_repo.lock");
    const release = await manager.acquire("repository:repo", "exclusive");
    const owner = JSON.parse(
      await readFile(path.join(lockPath, "owner.json"), "utf8")
    ) as { owner_token: string };
    const quarantine = `${lockPath}.released-${owner.owner_token}`;
    await mkdir(quarantine);
    await writeFile(path.join(quarantine, "occupied"), "keep");

    const first = release();
    const concurrent = release();
    await expect(first).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:EEXIST|ENOTEMPTY)$/u)
    });
    await expect(concurrent).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:EEXIST|ENOTEMPTY)$/u)
    });
    await expect(readFile(path.join(lockPath, "owner.json"), "utf8")).resolves.toContain(
      owner.owner_token
    );

    await rm(quarantine, { recursive: true });
    await expect(release()).resolves.toBeUndefined();
    await expect(release()).resolves.toBeUndefined();
    await expect(readFile(path.join(lockPath, "owner.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("keeps retrying a failed release when the caller drops the closure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    const manager = new RunLockManager({
      root,
      runId: "run-1",
      timeoutMs: 1000,
      staleAfterMs: 3000
    });
    const lockPath = path.join(root, "repository_repo.lock");
    const release = await manager.acquire("repository:repo", "exclusive");
    const owner = JSON.parse(
      await readFile(path.join(lockPath, "owner.json"), "utf8")
    ) as { owner_token: string };
    const quarantine = `${lockPath}.released-${owner.owner_token}`;
    await mkdir(quarantine);
    await writeFile(path.join(quarantine, "occupied"), "keep");

    await expect(release()).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:EEXIST|ENOTEMPTY)$/u)
    });
    const contender = new RunLockManager({
      root,
      runId: "run-2",
      timeoutMs: 20,
      staleAfterMs: 3000
    });
    await expect(
      contender.acquire("repository:repo", "exclusive", { timeoutMs: 20 })
    ).rejects.toMatchObject({ code: "lock_timeout" });

    await rm(quarantine, { recursive: true });
    const releaseContender = await contender.acquire(
      "repository:repo",
      "exclusive",
      { timeoutMs: 1000 }
    );
    await releaseContender();
  });

  it("does not let observability failures prevent acquire release or timeout behavior", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-locks-"));
    const observability = createObservabilityRecorder({
      run: { id: "run-1", workflowId: "code-review", attempt: 1 },
      sinks: [{
        id: "failing",
        required: true,
        emit: () => {
          throw new Error("observability failed");
        }
      }]
    });
    const manager = new RunLockManager({
      root,
      runId: "run-1",
      timeoutMs: 20,
      staleAfterMs: 3000,
      observability
    });

    const release = await manager.acquire("repository:repo", "exclusive");
    await expect(
      manager.acquire("repository:repo", "exclusive", { timeoutMs: 20 })
    ).rejects.toMatchObject({ code: "lock_timeout" });
    await expect(release()).resolves.toBeUndefined();
  });
});

async function waitForLog(
  telemetry: ReturnType<typeof createTelemetryBufferSink>,
  message: string
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      telemetry.records().some(
        (record) => record.type === "log" && record.log.message === message
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Log not observed: ${message}`);
}
