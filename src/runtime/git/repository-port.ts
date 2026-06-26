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
import { runGit as defaultRunGit } from "../../core/git/client.js";

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
        const [status, commitLine, message, paths] = await Promise.all([
          currentStatus({ operation_id: "git.status", workspace: input.workspace }, runGit),
          runGit(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"]),
          runGit(cwd, ["log", "-1", "--pretty=%B"]),
          runGit(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
        ]);
        const { commitSha, parentSha } = parseCommitLine(commitLine);

        return {
          operation_id: "git.commit",
          workspace_id: input.workspace.workspace_id,
          branch: status.branch,
          head_sha: parentSha ?? "",
          commit_sha: commitSha,
          message: message.trim(),
          paths: lines(paths)
        };
      },
      async commit(input): Promise<GitCommitResult> {
        const cwd = input.workspace.path;
        const status = await currentStatus(
          { operation_id: "git.status", workspace: input.workspace },
          runGit
        );
        assertExpectedHead(status, input);
        await runGit(cwd, [
          "--literal-pathspecs",
          "add",
          "-A",
          "--",
          ...commitPathsArgs(input.paths)
        ]);
        await runGit(cwd, ["commit", "-m", input.message]);
        const commitSha = (await runGit(cwd, ["rev-parse", "HEAD"])).trim();

        return {
          operation_id: "git.commit",
          workspace_id: input.workspace.workspace_id,
          branch: status.branch,
          head_sha: status.head_sha,
          commit_sha: commitSha,
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
