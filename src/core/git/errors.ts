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

export function codeForArgs(args: readonly string[]): GitErrorCode {
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

export function gitError(
  message: string,
  code: GitErrorCode,
  cause: unknown
): GitError {
  const error = new Error(message, { cause }) as GitError;
  error.code = code;
  error.cause = cause;

  return error;
}

export type GitFailureKind =
  | "branch_exists"
  | "pre_existing_staged_changes"
  | "nothing_to_commit"
  | "missing_identity"
  | "push_rejected"
  | "unknown";

export type GitFailure = {
  kind: GitFailureKind;
  command: string;
  args: string[];
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  message: string;
  stdoutSummary?: string;
  stderrSummary?: string;
};

type ProcessFailure = {
  code?: unknown;
  exitCode?: unknown;
  signal?: unknown;
  timedOut?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
};

function processFailureFrom(error: unknown): ProcessFailure {
  const direct = error as ProcessFailure | undefined;
  const cause = (error as { cause?: ProcessFailure } | undefined)?.cause;

  return cause ?? direct ?? {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function commandPartsFrom(message: string): { command: string; args: string[] } {
  const prefix = "Git command failed: ";

  if (!message.startsWith(prefix)) {
    return { command: "git", args: [] };
  }

  const parts = message.slice(prefix.length).trim().split(/\s+/);
  const [command = "git", ...args] = parts;

  return { command, args };
}

function firstLine(value: string | undefined): string | undefined {
  const line = value?.split(/\r?\n/).find((part) => part.trim() !== "")?.trim();

  return line === "" ? undefined : line;
}

function isBranchExistsMessage(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some(
      (line) =>
        /^fatal: a branch named '.+' already exists$/.test(line) ||
        /^fatal: A branch named '.+' already exists\.$/.test(line) ||
        /^fatal: cannot lock ref 'refs\/heads\/.+': 'refs\/heads\/.+' exists; cannot create 'refs\/heads\/.+'$/.test(
          line
        )
    );
}

function classifyKind({
  message,
  args,
  exitCode,
  stdout,
  stderr
}: {
  message: string;
  args: string[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}): GitFailureKind {
  if (isBranchExistsMessage(stderr) || isBranchExistsMessage(message)) {
    return "branch_exists";
  }

  if (
    args.join(" ") === "diff --cached --quiet --exit-code" &&
    exitCode === 1
  ) {
    return "pre_existing_staged_changes";
  }

  if (
    /nothing to commit/i.test(stderr ?? "") ||
    /nothing to commit/i.test(stdout ?? "") ||
    /nothing to commit/i.test(message)
  ) {
    return "nothing_to_commit";
  }

  if (
    /Author identity unknown/.test(stderr ?? "") ||
    /unable to auto-detect email address/.test(stderr ?? "")
  ) {
    return "missing_identity";
  }

  if (/rejected/i.test(stderr ?? "") && /\bpush\b/i.test(message)) {
    return "push_rejected";
  }

  return "unknown";
}

export function classifyGitFailure(error: unknown): GitFailure {
  const message =
    stringValue((error as { message?: unknown } | undefined)?.message) ??
    "Git command failed";
  const processFailure = processFailureFrom(error);
  const stderr = stringValue(processFailure.stderr);
  const stdout = stringValue(processFailure.stdout);
  const { command, args } = commandPartsFrom(message);
  const exitCode = numberValue(processFailure.exitCode ?? processFailure.code);

  return {
    kind: classifyKind({ message, args, exitCode, stdout, stderr }),
    command,
    args,
    exitCode,
    signal: stringValue(processFailure.signal),
    timedOut: processFailure.timedOut === true,
    message,
    stdoutSummary: firstLine(stdout),
    stderrSummary: firstLine(stderr)
  };
}
