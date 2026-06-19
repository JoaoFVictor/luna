import { stat as fsStat } from "node:fs/promises";
import { runGit as defaultRunGit } from "./git.js";
import {
  githubPullRequestContextFrom,
  type GitHubPullRequestContext
} from "./github-pr-context.js";
import { jiraIssueContextFrom } from "./jira-issue-context.js";
import { remoteUrlMatches } from "./remote-url.js";
import type {
  ImplementationConfig,
  Invocation,
  RepositoryConfig
} from "./types.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;
type Stat = (path: string) => Promise<{ isDirectory(): boolean }>;
type WorkflowMode = "git_managed_read_only" | "git_managed_write";

type PreflightErrorCode =
  | "invalid_invocation"
  | "repository_path_missing"
  | "not_git_repository"
  | "git_remote_missing"
  | "expected_remote_urls_missing"
  | "implementation_config_missing"
  | "remote_url_mismatch"
  | "push_requires_commit"
  | "pull_request_requires_push";

type PreflightError = Error & {
  code: PreflightErrorCode;
  cause?: unknown;
};

export type PreflightResult = {
  repository: {
    id: string;
    path: string;
    remote: string;
    remote_url: string;
  };
  expected: {
    base_ref?: string;
    base_sha?: string;
    head_sha?: string;
  };
};

function preflightError(
  message: string,
  code: PreflightErrorCode,
  cause?: unknown
): PreflightError {
  const error = new Error(message, { cause }) as PreflightError;
  error.code = code;

  return error;
}

function validateInvocation(invocation: Invocation): GitHubPullRequestContext {
  try {
    return githubPullRequestContextFrom(invocation);
  } catch (cause) {
    throw preflightError(
      "Invocation is missing required PR metadata",
      "invalid_invocation",
      cause
    );
  }
}

function validateWriteInvocation(writeInvocation: Invocation): void {
  try {
    jiraIssueContextFrom(writeInvocation);
  } catch (cause) {
    throw preflightError(
      "Invocation is missing required write-mode metadata",
      "invalid_invocation",
      cause
    );
  }
}

async function assertRepositoryPathExists(
  repository: RepositoryConfig,
  stat: Stat
): Promise<void> {
  try {
    const repositoryStat = await stat(repository.path);

    if (!repositoryStat.isDirectory()) {
      throw preflightError(
        `Repository path is not a directory: ${repository.path}`,
        "repository_path_missing"
      );
    }
  } catch (cause) {
    if ((cause as { code?: unknown }).code === "repository_path_missing") {
      throw cause;
    }

    throw preflightError(
      `Repository path is missing: ${repository.path}`,
      "repository_path_missing",
      cause
    );
  }
}

function assertWriteGateConsistency(
  implementation: ImplementationConfig["implementation"] | undefined
): void {
  if (implementation === undefined) {
    throw preflightError(
      "Write-mode workflows require config/implementation.yaml",
      "implementation_config_missing"
    );
  }

  if (implementation.push.enabled && !implementation.commit.enabled) {
    throw preflightError(
      "push.enabled requires commit.enabled",
      "push_requires_commit"
    );
  }

  if (implementation.pull_request.enabled && !implementation.push.enabled) {
    throw preflightError(
      "pull_request.enabled requires push.enabled",
      "pull_request_requires_push"
    );
  }
}

function assertExpectedRemoteUrl(
  repository: RepositoryConfig,
  remoteUrl: string
): void {
  if (
    repository.expected_remote_urls === undefined ||
    repository.expected_remote_urls.length === 0
  ) {
    throw preflightError(
      "Write-mode repositories require expected_remote_urls",
      "expected_remote_urls_missing"
    );
  }

  if (!remoteUrlMatches(remoteUrl, repository.expected_remote_urls)) {
    throw preflightError(
      "Configured remote URL does not match expected_remote_urls",
      "remote_url_mismatch"
    );
  }
}

export async function runPreflight({
  invocation,
  repository,
  workflow,
  implementation,
  runGit = defaultRunGit,
  stat = fsStat
}: {
  invocation: Invocation;
  repository: RepositoryConfig;
  workflow?: { mode: WorkflowMode };
  implementation?: ImplementationConfig["implementation"];
  runGit?: RunGit;
  stat?: Stat;
}): Promise<PreflightResult> {
  const mode = workflow?.mode ?? "git_managed_read_only";
  let pullRequestContext: GitHubPullRequestContext | undefined;

  if (mode === "git_managed_write") {
    validateWriteInvocation(invocation);
    assertWriteGateConsistency(implementation);
  } else {
    pullRequestContext = validateInvocation(invocation);
  }

  await assertRepositoryPathExists(repository, stat);

  await runGit(repository.path, ["rev-parse", "--is-inside-work-tree"]);
  const remoteUrl = (
    await runGit(repository.path, ["remote", "get-url", repository.remote])
  ).trim();

  if (mode === "git_managed_write") {
    assertExpectedRemoteUrl(repository, remoteUrl);
  }

  return {
    repository: {
      id: repository.id,
      path: repository.path,
      remote: repository.remote,
      remote_url: remoteUrl
    },
    expected:
      pullRequestContext !== undefined
        ? {
            base_ref: pullRequestContext.base_ref,
            base_sha: pullRequestContext.references.base_sha,
            head_sha: pullRequestContext.references.head_sha
          }
        : {}
  };
}
