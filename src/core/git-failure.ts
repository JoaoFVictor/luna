export type GitFailureKind =
  | "branch_exists"
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
  stderr
}: {
  message: string;
  stderr?: string;
}): GitFailureKind {
  if (isBranchExistsMessage(stderr) || isBranchExistsMessage(message)) {
    return "branch_exists";
  }

  if (
    /nothing to commit/i.test(stderr ?? "") ||
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

  return {
    kind: classifyKind({ message, stderr }),
    command,
    args,
    exitCode: numberValue(processFailure.exitCode ?? processFailure.code),
    signal: stringValue(processFailure.signal),
    timedOut: processFailure.timedOut === true,
    message,
    stdoutSummary: firstLine(stdout),
    stderrSummary: firstLine(stderr)
  };
}
