import { z } from "zod";
import { InvocationSchema, type Invocation } from "../../core/types.js";
import type { AdapterInput, InputAdapter } from "../types.js";

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

export type GitHubPullRequestAdapterError = Error & {
  code:
    | "invalid_pr_url"
    | "github_pull_request_fetch_failed"
    | "github_pull_request_invalid_response"
    | "github_pull_request_head_repo_missing";
  cause?: unknown;
};

function adapterError(
  code: GitHubPullRequestAdapterError["code"],
  message: string,
  cause?: unknown
): GitHubPullRequestAdapterError {
  const error = new Error(message, { cause }) as GitHubPullRequestAdapterError;
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

  if (
    owner === undefined ||
    repo === undefined ||
    kind !== "pull" ||
    number === undefined ||
    extra.length > 0 ||
    !/^[1-9]\d*$/.test(number)
  ) {
    throw adapterError("invalid_pr_url", `Expected GitHub PR URL: ${url}`);
  }

  const pullNumber = Number(number);
  if (!Number.isSafeInteger(pullNumber)) {
    throw adapterError("invalid_pr_url", `Expected GitHub PR URL: ${url}`);
  }

  return {
    owner: safeGitHubPathSegment(owner),
    repo: safeGitHubPathSegment(repo),
    pull_number: pullNumber
  };
}

async function fetchPullRequest(
  input: AdapterInput,
  executeJson: (command: string, args: string[]) => Promise<unknown>
): Promise<Invocation> {
  const coordinates = parseGitHubPullRequestUrl(input.value);
  let response: unknown;

  try {
    response = await executeJson("gh", [
      "api",
      `repos/${coordinates.owner}/${coordinates.repo}/pulls/${coordinates.pull_number}`
    ]);
  } catch (cause) {
    throw adapterError(
      "github_pull_request_fetch_failed",
      `Failed to load GitHub PR metadata with: gh api repos/${coordinates.owner}/${coordinates.repo}/pulls/${coordinates.pull_number}`,
      cause
    );
  }

  const parsed = GitHubPullRequestSchema.safeParse(response);
  if (!parsed.success) {
    throw adapterError(
      "github_pull_request_invalid_response",
      parsed.error.message,
      parsed.error
    );
  }

  const pullRequest = parsed.data;
  if (pullRequest.head.repo === null) {
    throw adapterError(
      "github_pull_request_head_repo_missing",
      "GitHub PR head repository is unavailable"
    );
  }

  const canonicalUrl = `https://github.com/${coordinates.owner}/${coordinates.repo}/pull/${pullRequest.number}`;

  return InvocationSchema.parse({
    version: "2026-06",
    source: "github",
    event: "pull_request",
    action: "selected",
    repository: {
      provider: "github",
      owner: coordinates.owner,
      name: coordinates.repo
    },
    subject: {
      type: "pull_request",
      id: String(pullRequest.number),
      url: canonicalUrl
    },
    references: {
      base_ref: pullRequest.base.ref,
      base_sha: pullRequest.base.sha,
      head_sha: pullRequest.head.sha
    },
    payload: {
      pull_request: {
        number: pullRequest.number
      },
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
      }
    }
  });
}

export const githubPrUrlAdapter: InputAdapter = {
  id: "github-pr-url",
  description: "Load a GitHub pull request from a github.com pull request URL.",
  async load(input, context) {
    return await fetchPullRequest(input, context.executeJson);
  }
};
