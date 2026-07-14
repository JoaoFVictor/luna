import type {
  GitBuiltInPorts,
  GitCommitInput,
  GitCommitResult,
  GitCommitState,
  GitPushBranchInput,
  GitPushBranchResult,
  GitStatusInput,
  GitStatusResult
} from "../../capabilities/git/contracts.js";
import { runGit as defaultRunGit } from "../../capabilities/git/client.js";
import { remoteUrlMatches } from "../../capabilities/git/remote-url.js";
import { commitApprovedWorktreeSnapshot } from "../../capabilities/git/worktree-snapshot.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;

function lines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

async function currentStatus(
  input: GitStatusInput,
  runGit: RunGit
): Promise<GitStatusResult> {
  const cwd = input.workspace.path;
  const [branch, headSha, staged, unstaged, untracked] = await Promise.all([
    runGit(cwd, ["branch", "--show-current"]),
    runGit(cwd, ["rev-parse", "HEAD"]),
    runGit(cwd, ["diff", "--name-only", "--cached"]),
    runGit(cwd, ["diff", "--name-only"]),
    runGit(cwd, ["ls-files", "--others", "--exclude-standard"])
  ]);
  const stagedPaths = lines(staged);
  const unstagedPaths = lines(unstaged);
  const untrackedPaths = lines(untracked);

  return {
    operation_id: "git.status",
    workspace_id: input.workspace.workspace_id,
    branch: branch.trim(),
    head_sha: headSha.trim(),
    dirty:
      stagedPaths.length > 0 ||
      unstagedPaths.length > 0 ||
      untrackedPaths.length > 0,
    staged_paths: stagedPaths,
    unstaged_paths: unstagedPaths,
    untracked_paths: untrackedPaths
  };
}

function commitPathsArgs(paths: readonly string[] | undefined): readonly string[] {
  return paths === undefined || paths.length === 0 ? ["."] : paths;
}

function dirtyPaths(status: GitStatusResult): string[] {
  return [...new Set([
    ...status.staged_paths,
    ...status.unstaged_paths,
    ...status.untracked_paths
  ])].sort();
}

function gitConflict(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "git_conflict";
  return error;
}

function parseCommitLine(line: string): { commitSha: string; parentSha?: string } {
  const [commitSha = "", parentSha] = line.trim().split(/\s+/);
  return { commitSha, parentSha };
}

function assertExpectedHead(status: GitStatusResult, input: GitCommitInput): void {
  if (
    (input.expected_branch !== undefined &&
      status.branch !== input.expected_branch) ||
    (input.expected_head_sha !== undefined &&
      status.head_sha !== input.expected_head_sha)
  ) {
    throw gitConflict("Git commit expected branch or head does not match workspace.");
  }
}

function isExpectedAncestryMismatch(error: unknown): boolean {
  const failure =
    (error as { cause?: { exitCode?: unknown; code?: unknown } } | undefined)
      ?.cause ?? (error as { exitCode?: unknown; code?: unknown } | undefined);
  const exitCode = failure?.exitCode ?? failure?.code;

  return exitCode === 1;
}

async function assertExpectedBaseAncestry(
  cwd: string,
  input: GitCommitInput,
  runGit: RunGit
): Promise<void> {
  if (input.expected_base_sha === undefined) {
    return;
  }

  try {
    await runGit(cwd, [
      "merge-base",
      "--is-ancestor",
      input.expected_base_sha,
      "HEAD"
    ]);
  } catch (error) {
    if (isExpectedAncestryMismatch(error)) {
      throw gitConflict("Git commit expected_base_sha is not an ancestor of HEAD.");
    }

    throw error;
  }
}

async function assertExpectedRemote(
  cwd: string,
  remote: string | undefined,
  expectedRemoteUrls: readonly string[] | undefined,
  runGit: RunGit
): Promise<void> {
  if (remote === undefined || expectedRemoteUrls === undefined) {
    return;
  }

  const actualRemoteUrl = (await runGit(cwd, ["remote", "get-url", remote])).trim();
  if (!remoteUrlMatches(actualRemoteUrl, expectedRemoteUrls)) {
    throw gitConflict("Git remote URL does not match expected URLs.");
  }
}

export function createGitRepositoryPorts({
  runGit = defaultRunGit
}: {
  readonly runGit?: RunGit;
} = {}): GitBuiltInPorts {
  return {
    repository: {
      async status(input) {
        return await currentStatus(input, runGit);
      },
      async readCommitState(input): Promise<GitCommitState | undefined> {
        const cwd = input.workspace.path;
        const [status, commitLine, message, paths, treeOid] = await Promise.all([
          currentStatus({ operation_id: "git.status", workspace: input.workspace }, runGit),
          runGit(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"]),
          runGit(cwd, ["log", "-1", "--pretty=%B"]),
          runGit(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]),
          runGit(cwd, ["rev-parse", "HEAD^{tree}"])
        ]);
        await assertExpectedBaseAncestry(cwd, input, runGit);
        await assertExpectedRemote(
          cwd,
          input.remote,
          input.expected_remote_urls,
          runGit
        );
        const { commitSha, parentSha } = parseCommitLine(commitLine);

        return {
          operation_id: "git.commit",
          workspace_id: input.workspace.workspace_id,
          branch: status.branch,
          head_sha: parentSha ?? "",
          commit_sha: commitSha,
          message: message.trim(),
          paths: lines(paths),
          tree_oid: treeOid.trim()
        };
      },
      async commit(input): Promise<GitCommitResult> {
        const cwd = input.workspace.path;
        const status = await currentStatus(
          { operation_id: "git.status", workspace: input.workspace },
          runGit
        );
        assertExpectedHead(status, input);
        await assertExpectedBaseAncestry(cwd, input, runGit);
        await assertExpectedRemote(
          cwd,
          input.remote,
          input.expected_remote_urls,
          runGit
        );
        let approvedCommit:
          | { readonly commit_sha: string; readonly tree_oid: string }
          | undefined;
        if (input.expected_snapshot === undefined) {
          await runGit(cwd, [
            "--literal-pathspecs",
            "add",
            "-A",
            "--",
            ...commitPathsArgs(input.paths)
          ]);
          await runGit(cwd, ["-c", "core.hooksPath=/dev/null", "commit", "-m", input.message]);
        } else {
          if (
            input.expected_snapshot.head_sha !== status.head_sha ||
            JSON.stringify([...input.expected_snapshot.changed_paths].sort()) !==
              JSON.stringify(dirtyPaths(status))
          ) {
            throw gitConflict("Git commit dirty paths or HEAD do not match the approved snapshot.");
          }
          try {
            approvedCommit = await commitApprovedWorktreeSnapshot({
              cwd,
              expected: input.expected_snapshot,
              message: input.message
            });
          } catch (cause) {
            throw gitConflict(
              cause instanceof Error ? cause.message : "Approved worktree snapshot changed."
            );
          }
        }
        const [commitSha, treeOid] = approvedCommit === undefined
          ? await Promise.all([
              runGit(cwd, ["rev-parse", "HEAD"]),
              runGit(cwd, ["rev-parse", "HEAD^{tree}"])
            ])
          : [approvedCommit.commit_sha, approvedCommit.tree_oid];
        if (
          input.expected_snapshot !== undefined &&
          treeOid.trim() !== input.expected_snapshot.tree_oid
        ) {
          throw gitConflict("Committed Git tree does not match the approved snapshot.");
        }

        return {
          operation_id: "git.commit",
          workspace_id: input.workspace.workspace_id,
          branch: status.branch,
          head_sha: status.head_sha,
          commit_sha: commitSha.trim(),
          tree_oid: treeOid.trim(),
          message: input.message,
          ...(input.paths === undefined ? {} : { paths: input.paths }),
          adopted: false
        };
      },
      async pushBranch(input: GitPushBranchInput): Promise<GitPushBranchResult> {
        const cwd = input.workspace.path;
        const headSha = (await runGit(cwd, ["rev-parse", "HEAD"])).trim();
        if (headSha !== input.expected_commit_sha) {
          throw gitConflict("Git push expected_commit_sha does not match HEAD.");
        }
        if (input.expected_remote_urls !== undefined) {
          await assertExpectedRemote(
            cwd,
            input.remote,
            input.expected_remote_urls,
            runGit
          );
        }

        await runGit(cwd, ["push", input.remote, input.branch]);

        return {
          operation_id: "git.push_branch",
          workspace_id: input.workspace.workspace_id,
          branch: input.branch,
          remote: input.remote,
          commit_sha: headSha,
          pushed: true
        };
      }
    }
  };
}
