import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { InvocationSchema, type Invocation } from "./types.js";

const execFileAsync = promisify(execFile);

const GitHubRepositorySchema = z
  .object({
    name: z.string().min(1),
    full_name: z.string().min(1),
    fork: z.boolean().optional(),
    owner: z
      .object({
        login: z.string().min(1)
      })
      .passthrough()
  })
  .passthrough();

const GitHubPullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    base: z
      .object({
        ref: z.string().min(1),
        sha: z.string().min(1),
        repo: GitHubRepositorySchema
      })
      .passthrough(),
    head: z
      .object({
        sha: z.string().min(1),
        repo: GitHubRepositorySchema.nullable()
      })
      .passthrough()
  })
  .passthrough();

export type PullRequestCoordinates = {
  owner: string;
  repo: string;
  pull_number: number;
};

export type ExecuteJson = (command: string, args: string[]) => Promise<unknown>;

export type FetchGitHubPullRequestInvocationOptions = {
  executeJson?: ExecuteJson;
};

export type GitHubPrAdapterError = Error & {
  code:
    | "invalid_pr_url"
    | "github_pr_fetch_failed"
    | "github_pr_invalid_response"
    | "github_pr_head_repo_missing";
  cause?: unknown;
};

function adapterError(
  code: GitHubPrAdapterError["code"],
  message: string,
  cause?: unknown
): GitHubPrAdapterError {
  const error = new Error(message, { cause }) as GitHubPrAdapterError;
  error.code = code;
  error.cause = cause;

  return error;
}

function safeGitHubPathSegment(segment: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(segment)) {
    throw adapterError("invalid_pr_url", `Invalid GitHub URL path segment: ${segment}`);
  }

  return segment;
}

export function parseGitHubPullRequestUrl(url: string): PullRequestCoordinates {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw adapterError("invalid_pr_url", `Invalid pull request URL: ${url}`, cause);
  }

  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    throw adapterError("invalid_pr_url", `Expected a github.com pull request URL: ${url}`);
  }

  const [owner, repo, kind, number, ...extra] = parsed.pathname
    .split("/")
    .filter(Boolean);
  const pullNumber = Number(number);

  if (
    owner === undefined ||
    repo === undefined ||
    kind !== "pull" ||
    extra.length > 0 ||
    !Number.isSafeInteger(pullNumber) ||
    pullNumber < 1
  ) {
    throw adapterError("invalid_pr_url", `Expected GitHub PR URL: ${url}`);
  }

  return {
    owner: safeGitHubPathSegment(owner),
    repo: safeGitHubPathSegment(repo),
    pull_number: pullNumber
  };
}

async function executeGhJson(command: string, args: string[]): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024
    });

    return JSON.parse(stdout);
  } catch (cause) {
    throw adapterError(
      "github_pr_fetch_failed",
      `Failed to load GitHub PR metadata with: ${command} ${args.join(" ")}`,
      cause
    );
  }
}

export async function fetchGitHubPullRequestInvocation(
  url: string,
  options: FetchGitHubPullRequestInvocationOptions = {}
): Promise<Invocation> {
  const coordinates = parseGitHubPullRequestUrl(url);
  const executeJson = options.executeJson ?? executeGhJson;
  const response = await executeJson("gh", [
    "api",
    `repos/${coordinates.owner}/${coordinates.repo}/pulls/${coordinates.pull_number}`
  ]);
  const parsed = GitHubPullRequestSchema.safeParse(response);

  if (!parsed.success) {
    throw adapterError(
      "github_pr_invalid_response",
      parsed.error.message,
      parsed.error
    );
  }

  const pullRequest = parsed.data;
  if (pullRequest.head.repo === null) {
    throw adapterError(
      "github_pr_head_repo_missing",
      "GitHub PR head repository is unavailable"
    );
  }

  return InvocationSchema.parse({
    target: "github_pr",
    owner: coordinates.owner,
    repo: coordinates.repo,
    pull_number: pullRequest.number,
    base_ref: pullRequest.base.ref,
    base_repository: {
      owner: pullRequest.base.repo.owner.login,
      name: pullRequest.base.repo.name,
      full_name: pullRequest.base.repo.full_name
    },
    head_repository: {
      owner: pullRequest.head.repo.owner.login,
      name: pullRequest.head.repo.name,
      full_name: pullRequest.head.repo.full_name,
      fork: pullRequest.head.repo.fork
    },
    references: {
      base_sha: pullRequest.base.sha,
      head_sha: pullRequest.head.sha
    }
  });
}
