import { chmod, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createGitCommitBuiltIn } from "../../../src/capabilities/git/commit.js";
import { runGit } from "../../../src/capabilities/git/client.js";
import {
  captureApprovedWorktreeSnapshot,
  commitApprovedWorktreeSnapshot
} from "../../../src/capabilities/git/worktree-snapshot.js";
import { createGitRepositoryPorts } from "../../../src/runtime/git/repository-port.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "luna-approved-tree-"));
  roots.push(root);
  await runGit(root, ["init", "--quiet", "--initial-branch=task/run-1"]);
  await runGit(root, ["config", "user.name", "Luna Test"]);
  await runGit(root, ["config", "user.email", "luna@example.invalid"]);
  await writeFile(path.join(root, "source.txt"), "base\n");
  await runGit(root, ["add", "source.txt"]);
  await runGit(root, ["commit", "--quiet", "-m", "base"]);
  await writeFile(path.join(root, "source.txt"), "approved\n");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })
  ));
});

describe("approved Git worktree snapshots", () => {
  it("commits the exact approved tree", async () => {
    const root = await repository();
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 255]));
    const approved = await captureApprovedWorktreeSnapshot({ cwd: root });

    await commitApprovedWorktreeSnapshot({
      cwd: root,
      expected: approved,
      message: "approved binary change"
    });

    await expect(runGit(root, ["rev-parse", "HEAD^{tree}"]).then((value) => value.trim()))
      .resolves.toBe(approved.tree_oid);
    await expect(runGit(root, ["log", "-1", "--pretty=%B"]).then((value) => value.trim()))
      .resolves.toBe("approved binary change");
    await expect(runGit(root, ["log", "-1", "--pretty=%an <%ae>"]).then((value) => value.trim()))
      .resolves.toBe("Luna Test <luna@example.invalid>");
  });

  it("advances detached HEAD with the same compare-and-swap semantics", async () => {
    const root = await repository();
    await runGit(root, ["checkout", "--detach", "--quiet", "HEAD"]);
    const approved = await captureApprovedWorktreeSnapshot({ cwd: root });

    const result = await commitApprovedWorktreeSnapshot({
      cwd: root,
      expected: approved,
      message: "detached approved change"
    });

    await expect(runGit(root, ["rev-parse", "HEAD"]).then((value) => value.trim()))
      .resolves.toBe(result.commit_sha);
    await expect(runGit(root, ["rev-parse", "HEAD^1"]).then((value) => value.trim()))
      .resolves.toBe(approved.head_sha);
    await expect(execFileAsync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: root }))
      .rejects.toMatchObject({ code: 1 });
  });

  const mutations: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (root: string) => Promise<void>;
  }> = [
    {
      name: "same-path content replacement",
      mutate: async (root) => await writeFile(path.join(root, "source.txt"), "mutated\n")
    },
    {
      name: "new untracked file",
      mutate: async (root) => await writeFile(path.join(root, "later.txt"), "later\n")
    },
    {
      name: "deletion",
      mutate: async (root) => await rm(path.join(root, "source.txt"))
    },
    {
      name: "rename",
      mutate: async (root) => await rename(
        path.join(root, "source.txt"),
        path.join(root, "renamed.txt")
      )
    },
    {
      name: "executable-mode change",
      mutate: async (root) => await chmod(path.join(root, "source.txt"), 0o755)
    },
    {
      name: "symlink replacement",
      mutate: async (root) => {
        await rm(path.join(root, "source.txt"));
        await symlink("target-outside-worktree", path.join(root, "source.txt"));
      }
    }
  ];

  for (const mutation of mutations) {
    it(`rejects ${mutation.name} after approval`, async () => {
      const root = await repository();
      const approved = await captureApprovedWorktreeSnapshot({ cwd: root });
      await mutation.mutate(root);

      await expect(commitApprovedWorktreeSnapshot({
        cwd: root,
        expected: approved,
        message: "must not commit"
      }))
        .rejects.toThrow(/approved Git tree snapshot/u);
    });
  }

  it("does not consume a concurrently mutated shared index", async () => {
    const root = await repository();
    const approved = await captureApprovedWorktreeSnapshot({ cwd: root });
    let injected = false;

    const result = await commitApprovedWorktreeSnapshot({
      cwd: root,
      expected: approved,
      message: "approved private index",
      runGitWithEnvironment: async (cwd, args, environment, signal) => {
        if (!injected && args.includes("commit-tree")) {
          injected = true;
          await writeFile(path.join(root, "source.txt"), "unapproved concurrent content\n");
          await runGit(root, ["add", "-A", "--", "."]);
        }
        const { stdout } = await execFileAsync("git", [...args], {
          cwd,
          env: environment,
          ...(signal === undefined ? {} : { signal })
        });
        return stdout;
      }
    });

    expect(injected).toBe(true);
    expect(result.tree_oid).toBe(approved.tree_oid);
    await expect(runGit(root, ["show", "HEAD:source.txt"]))
      .resolves.toBe("approved\n");
    await expect(runGit(root, ["status", "--porcelain"]))
      .resolves.toContain("source.txt");
  });

  it("fails closed when HEAD advances before the compare-and-swap", async () => {
    const root = await repository();
    const approved = await captureApprovedWorktreeSnapshot({ cwd: root });
    let externalCommit = "";

    await expect(commitApprovedWorktreeSnapshot({
      cwd: root,
      expected: approved,
      message: "must lose the ref race",
      runGitCommand: async (cwd, args) => {
        if (args.includes("update-ref") && externalCommit === "") {
          await runGit(root, ["commit", "--allow-empty", "--quiet", "-m", "external"]);
          externalCommit = (await runGit(root, ["rev-parse", "HEAD"])).trim();
        }
        return await runGit(cwd, args);
      }
    })).rejects.toMatchObject({ code: "git_command_failed" });

    expect(externalCommit).not.toBe("");
    await expect(runGit(root, ["rev-parse", "HEAD"]).then((value) => value.trim()))
      .resolves.toBe(externalCommit);
    await expect(runGit(root, ["show", "HEAD:source.txt"]))
      .resolves.toBe("base\n");
  });

  it("commits the approved tree and adopts the exact commit on replay", async () => {
    const root = await repository();
    const approved = await captureApprovedWorktreeSnapshot({ cwd: root });
    const workspace = {
      operation_id: "repository-workspace.capture" as const,
      run_id: "run-1",
      repository_id: "repo-1",
      workspace_id: "workspace-1",
      path: root,
      preserved: true,
      reason: "active",
      lifecycle: "active" as const,
      captured_at: "2026-07-13T12:00:00.000Z"
    };
    const state = {
      invocation: {},
      run: { run_id: "run-1" },
      workflow: { id: "implementation", mode: "trusted_local_write" as const },
      repository: { id: "repo-1" },
      workspace,
      steps: {}
    };
    const ports = createGitRepositoryPorts();
    const commit = createGitCommitBuiltIn(ports);
    const input = {
      operation_id: "git.commit",
      message: "approved change",
      paths: approved.changed_paths,
      expected_snapshot: approved
    };

    const first = await commit.run({ state, input });
    const replay = await commit.run({ state, input });

    expect(first).toMatchObject({ adopted: false, tree_oid: approved.tree_oid });
    expect(replay).toMatchObject({ adopted: true, tree_oid: approved.tree_oid });
    await expect(runGit(root, ["status", "--porcelain"]).then((value) => value.trim()))
      .resolves.toBe("");
  });
});
