import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemStudioLockManager } from "../../../src/studio/adapters/filesystem/studio-lock-manager.js";

const temporaryRoots: string[] = [];

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "luna-studio-lock-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) =>
      await rm(root, { recursive: true, force: true })
    )
  );
});

describe("FileSystemStudioLockManager", () => {
  it("serializes two independent instances and releases idempotently", async () => {
    const projectRoot = await temporaryProject();
    const first = new FileSystemStudioLockManager({
      projectRoot,
      startupOwnerId: "first-owner-00000001",
      timeoutMs: 2_000,
      staleAfterMs: 3_000
    });
    const second = new FileSystemStudioLockManager({
      projectRoot,
      startupOwnerId: "second-owner-0000002",
      timeoutMs: 2_000,
      staleAfterMs: 3_000
    });

    const releaseFirst = await first.acquire("studio-apply", "exclusive");
    let secondAcquired = false;
    const secondReleasePromise = second
      .acquire("studio-apply", "exclusive")
      .then((release) => {
        secondAcquired = true;
        return release;
      });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(secondAcquired).toBe(false);
    await releaseFirst();
    await releaseFirst();
    const releaseSecond = await secondReleasePromise;
    expect(secondAcquired).toBe(true);
    await releaseSecond();

    const studioMode = (await stat(path.join(projectRoot, ".luna", "studio"))).mode & 0o777;
    const lockMode = (await stat(path.join(projectRoot, ".luna", "studio", "locks"))).mode & 0o777;
    expect(studioMode).toBe(0o700);
    expect(lockMode).toBe(0o700);
  });

  it("hashes resources so slug collisions do not serialize unrelated locks", async () => {
    const projectRoot = await temporaryProject();
    const manager = new FileSystemStudioLockManager({
      projectRoot,
      startupOwnerId: "collision-owner-00001",
      timeoutMs: 500,
      staleAfterMs: 3_000
    });
    const releaseColon = await manager.acquire("a:b", "exclusive");
    const releaseUnderscore = await manager.acquire("a_b", "exclusive");
    const lockEntries = (await readdir(
      path.join(projectRoot, ".luna", "studio", "locks")
    )).filter((name) => name.endsWith(".lock"));
    expect(lockEntries).toHaveLength(2);
    expect(lockEntries.join(" ")).not.toContain("a:b");
    expect(lockEntries.join(" ")).not.toContain("a_b");
    await releaseUnderscore();
    await releaseColon();
  });

  it("rejects a symlinked private lock parent", async () => {
    const projectRoot = await temporaryProject();
    const outside = await temporaryProject();
    await mkdir(path.join(projectRoot, ".luna"));
    await symlink(outside, path.join(projectRoot, ".luna", "studio"));
    const manager = new FileSystemStudioLockManager({
      projectRoot,
      startupOwnerId: "symlink-owner-000001",
      timeoutMs: 500,
      staleAfterMs: 3_000
    });
    await expect(manager.acquire("drafts", "exclusive")).rejects.toMatchObject({
      code: "studio_apply_path_invalid"
    });
  });

  it("reports a release failure and keeps releasing after the closure is dropped", async () => {
    const projectRoot = await temporaryProject();
    const manager = new FileSystemStudioLockManager({
      projectRoot,
      startupOwnerId: "release-owner-000001",
      timeoutMs: 500,
      staleAfterMs: 3_000
    });
    const release = await manager.acquire("drafts", "exclusive");
    const lockRoot = path.join(projectRoot, ".luna", "studio", "locks");
    const [lockName] = (await readdir(lockRoot)).filter((name) =>
      name.endsWith(".lock")
    );
    expect(lockName).toBeDefined();
    const lockPath = path.join(lockRoot, lockName!);
    const owner = JSON.parse(
      await readFile(path.join(lockPath, "owner.json"), "utf8")
    ) as { owner_token: string };
    const quarantine = `${lockPath}.released-${owner.owner_token}`;
    await mkdir(quarantine);
    await writeFile(path.join(quarantine, "block"), "occupied");
    await expect(release()).rejects.toBeDefined();
    await rm(quarantine, { recursive: true });
    const contender = new FileSystemStudioLockManager({
      projectRoot,
      startupOwnerId: "release-contender-001",
      timeoutMs: 2_000,
      staleAfterMs: 3_000
    });
    const releaseContender = await contender.acquire("drafts", "exclusive");
    await releaseContender();
    await expect(release()).resolves.toBeUndefined();
    expect(
      (await readdir(lockRoot)).filter((name) => name.endsWith(".lock"))
    ).toEqual([]);
  });
});
