import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
