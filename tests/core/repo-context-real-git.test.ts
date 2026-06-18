import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepare } from "../../src/core/git-worktree-manager.js";
import { collectRepoContext } from "../../src/core/repo-context-collector.js";
import {
  createRealGitReviewFixture,
  type RealGitReviewFixture
} from "../fixtures/git-repo.js";

describe("repo context collector with real Git", () => {
  const fixtures: RealGitReviewFixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  async function fixture(): Promise<RealGitReviewFixture> {
    const created = await createRealGitReviewFixture();
    fixtures.push(created);
    return created;
  }

  it("fetches fork-shaped PR refs from the configured base repository remote", async () => {
    const created = await fixture();
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "luna-real-worktrees-"));

    const workspace = await prepare({
      invocation: created.invocation,
      repository: created.repository,
      workspaceRoot,
      runId: "real-git-fork-ref"
    });

    const context = await collectRepoContext({
      invocation: created.invocation,
      repository: {
        ...created.repository,
        path: workspace.path
      },
      maxExcerptBytes: 64
    });

    expect(created.invocation.head_repository.full_name).not.toBe(
      created.invocation.base_repository.full_name
    );
    expect(context.base_sha).toBe(created.base_sha);
    expect(context.head_sha).toBe(created.head_sha);
    expect(context.files.map((file) => file.path)).toContain("review-target.ts");
  });

  it("throws head_sha_mismatch when the fetched PR head differs from the invocation head", async () => {
    const created = await fixture();
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "luna-real-worktrees-"));

    await expect(
      prepare({
        invocation: created.headMismatchInvocation,
        repository: created.repository,
        workspaceRoot,
        runId: "real-git-head-mismatch"
      })
    ).rejects.toMatchObject({
      code: "head_sha_mismatch"
    });
  });

  it("collects real Git metadata for rename, delete, binary, large, LFS, and submodule changes", async () => {
    const created = await fixture();

    const context = await collectRepoContext({
      invocation: created.invocation,
      repository: created.repository,
      maxExcerptBytes: 32
    });
    const file = (filePath: string) =>
      context.files.find((changedFile) => changedFile.path === filePath);

    expect(file("renamed-new.txt")).toMatchObject({
      status: "renamed",
      previous_path: "renamed-old.txt"
    });
    expect(file("deleted.txt")).toMatchObject({
      status: "deleted",
      excerpt: null
    });
    expect(file("binary.dat")).toMatchObject({
      binary: true,
      patch: null,
      excerpt: null
    });
    expect(file("large.txt")).toMatchObject({
      is_large: true
    });
    expect(file("asset.bin")).toMatchObject({
      is_lfs_pointer: true
    });
    expect(file("vendor/lib")).toMatchObject({
      is_submodule: true
    });
  });
});
