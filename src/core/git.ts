import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitErrorCode =
  | "git_fetch_failed"
  | "worktree_create_failed"
  | "worktree_remove_failed"
  | "git_remote_missing"
  | "not_git_repository"
  | "workspace_record_missing"
  | "workspace_record_mismatch"
  | "git_command_failed";

export type GitError = Error & {
  code: GitErrorCode;
  cause: unknown;
};

function codeForArgs(args: readonly string[]): GitErrorCode {
  if (args[0] === "fetch") {
    return "git_fetch_failed";
  }

  if (args[0] === "worktree" && args[1] === "add") {
    return "worktree_create_failed";
  }

  if (args[0] === "worktree" && args[1] === "remove") {
    return "worktree_remove_failed";
  }

  if (args[0] === "remote" && args[1] === "get-url") {
    return "git_remote_missing";
  }

  if (args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) {
    return "not_git_repository";
  }

  return "git_command_failed";
}

function gitError(
  message: string,
  code: GitErrorCode,
  cause: unknown
): GitError {
  const error = new Error(message, { cause }) as GitError;
  error.code = code;
  error.cause = cause;

  return error;
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  timeoutMs = 60000
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      timeout: timeoutMs
    });

    return stdout;
  } catch (cause) {
    throw gitError(
      `Git command failed: git ${args.join(" ")}`,
      codeForArgs(args),
      cause
    );
  }
}
