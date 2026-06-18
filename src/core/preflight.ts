import { stat as fsStat } from "node:fs/promises";
import { runGit as defaultRunGit } from "./git.js";
import type { Invocation, RepositoryConfig } from "./types.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;
type Stat = (path: string) => Promise<{ isDirectory(): boolean }>;

type PreflightErrorCode =
  | "invalid_invocation"
  | "repository_path_missing"
  | "not_git_repository"
  | "git_remote_missing";

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
    base_ref: string;
    base_sha: string;
    head_sha: string;
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

function validateInvocation(invocation: Invocation): void {
  if (
    invocation.target !== "github_pr" ||
    !Number.isSafeInteger(invocation.pull_number) ||
    invocation.pull_number < 1 ||
    invocation.base_repository.owner === "" ||
    invocation.base_repository.name === "" ||
    typeof invocation.base_ref !== "string" ||
    invocation.base_ref === "" ||
    invocation.head_repository.owner === "" ||
    invocation.head_repository.name === "" ||
    invocation.references.base_sha === "" ||
    invocation.references.head_sha === ""
  ) {
    throw preflightError("Invocation is missing required PR metadata", "invalid_invocation");
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

export async function runPreflight({
  invocation,
  repository,
  runGit = defaultRunGit,
  stat = fsStat
}: {
  invocation: Invocation;
  repository: RepositoryConfig;
  runGit?: RunGit;
  stat?: Stat;
}): Promise<PreflightResult> {
  validateInvocation(invocation);
  await assertRepositoryPathExists(repository, stat);

  await runGit(repository.path, ["rev-parse", "--is-inside-work-tree"]);
  const remoteUrl = (
    await runGit(repository.path, ["remote", "get-url", repository.remote])
  ).trim();

  return {
    repository: {
      id: repository.id,
      path: repository.path,
      remote: repository.remote,
      remote_url: remoteUrl
    },
    expected: {
      base_ref: invocation.base_ref,
      base_sha: invocation.references.base_sha,
      head_sha: invocation.references.head_sha
    }
  };
}
