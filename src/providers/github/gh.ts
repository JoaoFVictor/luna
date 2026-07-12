import { spawn } from "node:child_process";

export type RunGhOptions = {
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type RunGh = (
  cwd: string,
  args: readonly string[],
  options?: RunGhOptions
) => Promise<string>;

export type GitHubCliError = Error & {
  code: "github_cli_failed";
  details: {
    exit_code: number | null;
    stderr: string;
    timed_out: boolean;
  };
};

function githubCliError(
  message: string,
  details: GitHubCliError["details"]
): GitHubCliError {
  const error = new Error(message) as GitHubCliError;
  error.code = "github_cli_failed";
  error.details = details;

  return error;
}

export async function runGh(
  cwd: string,
  args: readonly string[],
  options: RunGhOptions = {}
): Promise<string> {
  const child = spawn("gh", [...args], {
    cwd,
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1"
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let timedOut = false;
  const timeout = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);

  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(options.input ?? "");

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  if (code !== 0) {
    throw githubCliError(
      timedOut ? "GitHub CLI command timed out" : "GitHub CLI command failed",
      {
        exit_code: code,
        stderr: Buffer.concat(stderr).toString("utf8"),
        timed_out: timedOut
      }
    );
  }

  return Buffer.concat(stdout).toString("utf8");
}

export async function runGhJson(
  cwd: string,
  args: readonly string[],
  payload: unknown,
  run: RunGh = runGh
): Promise<unknown> {
  const output = await run(cwd, args, {
    input: JSON.stringify(payload),
    timeoutMs: 60_000
  });

  return JSON.parse(output) as unknown;
}
