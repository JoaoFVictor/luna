import { stat as fsStat } from "node:fs/promises";
import { runGit as defaultRunGit } from "../git/client.js";
import { remoteUrlMatches } from "../git/remote-url.js";
import type { Invocation } from "../router/invocation.js";
import type { RepositoryConfig } from "../config/schemas.js";
import type { ImplementationConfig } from "../write-mode/types.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;
type Stat = (path: string) => Promise<{ isDirectory(): boolean }>;
type WorkflowMode = "read_only" | "trusted_local_write";

type PreflightErrorCode =
  | "invalid_invocation"
  | "repository_path_missing"
  | "not_git_repository"
  | "git_remote_missing"
  | "expected_remote_urls_missing"
  | "implementation_config_missing"
  | "remote_url_mismatch"
  | "push_requires_commit"
  | "change_request_requires_push";

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

function expectedRefsFromInvocation(invocation: Invocation): PreflightResult["expected"] {
  const baseRef = invocation.references?.base_ref;
  const baseSha = invocation.references?.base_sha;
  const headSha = invocation.references?.head_sha;

  if (
    baseRef === undefined ||
    baseRef.trim() === "" ||
    baseSha === undefined ||
    baseSha.trim() === "" ||
    headSha === undefined ||
    headSha.trim() === ""
  ) {
    throw preflightError(
      "Invocation is missing required read-mode refs",
      "invalid_invocation"
    );
  }

  return {
    base_ref: baseRef,
    base_sha: baseSha,
    head_sha: headSha
  };
}

function validateWriteInvocation(writeInvocation: Invocation): void {
  if (writeInvocation.repository === undefined || writeInvocation.subject === undefined) {
    throw preflightError(
      "Invocation is missing required write-mode metadata",
      "invalid_invocation"
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

  if (implementation.change_request.enabled && !implementation.push.enabled) {
    throw preflightError(
      "change_request.enabled requires push.enabled",
      "change_request_requires_push"
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
  const mode = workflow?.mode ?? "read_only";
  let expected: PreflightResult["expected"] = {};

  if (mode === "trusted_local_write") {
    validateWriteInvocation(invocation);
    assertWriteGateConsistency(implementation);
  } else {
    expected = expectedRefsFromInvocation(invocation);
  }

  await assertRepositoryPathExists(repository, stat);

  await runGit(repository.path, ["rev-parse", "--is-inside-work-tree"]);
  const remoteUrl = (
    await runGit(repository.path, ["remote", "get-url", repository.remote])
  ).trim();

  if (mode === "trusted_local_write") {
    assertExpectedRemoteUrl(repository, remoteUrl);
  }

  return {
    repository: {
      id: repository.id,
      path: repository.path,
      remote: repository.remote,
      remote_url: remoteUrl
    },
    expected
  };
}
