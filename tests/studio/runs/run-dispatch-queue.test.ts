import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeStudioRunDispatchQueue } from "../../../src/studio/adapters/filesystem/run-dispatch-queue.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("native Studio run dispatch queue", () => {
  it("paginates 10,001 jobs without aborting the global scan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-dispatch-queue-"));
    temporaryDirectories.push(root);
    const queue = new NativeStudioRunDispatchQueue({ root });
    await queue.initialize();
    const jobsRoot = path.join(root, "jobs");
    const runIds = Array.from(
      { length: 10_001 },
      (_, index) => `queued-${String(index).padStart(5, "0")}`
    );
    for (let offset = 0; offset < runIds.length; offset += 250) {
      await Promise.all(runIds.slice(offset, offset + 250).map((runId) =>
        mkdir(path.join(jobsRoot, runId))
      ));
    }

    const first = await queue.scanRunIds();
    const second = await queue.scanRunIds();

    expect(first).toMatchObject({ complete: false });
    expect(first.runIds).toHaveLength(10_000);
    expect(second).toMatchObject({ complete: true });
    expect(second.runIds).toHaveLength(1);
    expect(new Set([...first.runIds, ...second.runIds])).toEqual(
      new Set(runIds)
    );
    await queue.scanRunIds();
    await expect(queue.listRunIds()).resolves.toHaveLength(10_001);
  }, 30_000);
});
