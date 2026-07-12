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
    stdout: string;
    stderr: string;
    timed_out: boolean;
  };
};

export type GitHubApiErrorResponse = {
  readonly message?: string;
  readonly errors: readonly string[];
  readonly status?: number;
  readonly documentation_url?: string;
};

export function githubApiErrorResponse(
  error: unknown
): GitHubApiErrorResponse | undefined {
  const candidate = error as {
    code?: unknown;
    details?: { stdout?: unknown; timed_out?: unknown };
  } | undefined;
  if (
    candidate?.code !== "github_cli_failed" ||
    candidate.details?.timed_out === true ||
    typeof candidate.details?.stdout !== "string"
  ) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.details.stdout) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const response = parsed as {
    message?: unknown;
    errors?: unknown;
    status?: unknown;
    documentation_url?: unknown;
  };
  const status = typeof response.status === "number"
    ? response.status
    : typeof response.status === "string" && /^\d+$/.test(response.status)
      ? Number(response.status)
      : undefined;
  const errors = Array.isArray(response.errors)
    ? response.errors.filter((item): item is string => typeof item === "string")
    : [];

  if (status === undefined && typeof response.message !== "string" && errors.length === 0) {
    return undefined;
  }

  return {
    ...(typeof response.message === "string" ? { message: response.message } : {}),
    errors,
    ...(status === undefined ? {} : { status }),
    ...(typeof response.documentation_url === "string"
      ? { documentation_url: response.documentation_url }
      : {})
  };
}

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
    const capturedStdout = Buffer.concat(stdout).toString("utf8");
    throw githubCliError(
      timedOut ? "GitHub CLI command timed out" : "GitHub CLI command failed",
      {
        exit_code: code,
        stdout: capturedStdout,
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
