import { gitPushBranchMetadata } from "../../core/built-ins/metadata.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import type { BuiltInStep, BuiltInStepRunOptions } from "../../core/built-ins/types.js";
import type {
  GitPushBranchInput,
  GitPushBranchSkippedInput,
  GitPushBranchSkippedResult
} from "./contracts.js";
import {
  gitError,
  type GitBuiltInPortResolver,
  resolvePorts,
  workspaceFrom
} from "./shared.js";

type GitPushBranchBuiltInInput = {
  readonly operation_id: "git.push_branch";
  readonly branch: string;
  readonly remote: string;
  readonly expected_commit_sha: string;
  readonly expected_remote_urls?: readonly string[];
};

function pushInputFrom(
  input: Record<string, unknown> | undefined,
  state: BuiltInStepRunOptions["state"]
): GitPushBranchInput | GitPushBranchSkippedInput {
  if (
    input?.operation_id !== undefined &&
    input.operation_id !== "git.push_branch"
  ) {
    throw gitError("Git push operation_id is invalid.", "git_input_invalid");
  }

  if (input?.skipped === true) {
    if (typeof input.enabled !== "boolean" || typeof input.reason !== "string") {
      throw gitError("Git push skip input is invalid.", "git_input_invalid");
    }

    return {
      operation_id: "git.push_branch",
      enabled: input.enabled,
      skipped: true,
      reason: input.reason
    };
  }

  if (typeof input?.branch !== "string" || input.branch === "") {
    throw gitError("Git push branch is required.", "git_input_invalid");
  }
  if (typeof input?.remote !== "string" || input.remote === "") {
    throw gitError("Git push remote is required.", "git_input_invalid");
  }
  if (
    typeof input?.expected_commit_sha !== "string" ||
    input.expected_commit_sha === ""
  ) {
    throw gitError(
      "Git push expected_commit_sha is required.",
      "git_input_invalid"
    );
  }

  const branch = input.branch;
  const remote = input.remote;
  const expectedCommitSha = input.expected_commit_sha;
  const expectedRemoteUrls = input.expected_remote_urls;
  if (
    expectedRemoteUrls !== undefined &&
    (!Array.isArray(expectedRemoteUrls) ||
      expectedRemoteUrls.some((candidate) => typeof candidate !== "string"))
  ) {
    throw gitError(
      "Git push expected_remote_urls must be strings.",
      "git_input_invalid"
    );
  }

  const pushInput: GitPushBranchBuiltInInput = {
    operation_id: "git.push_branch",
    branch,
    remote,
    expected_commit_sha: expectedCommitSha,
    ...(expectedRemoteUrls === undefined
      ? {}
      : { expected_remote_urls: expectedRemoteUrls })
  };

  return {
    operation_id: pushInput.operation_id,
    workspace: workspaceFrom(state),
    branch: pushInput.branch,
    remote: pushInput.remote,
    expected_commit_sha: pushInput.expected_commit_sha,
    ...(pushInput.expected_remote_urls === undefined
      ? {}
      : { expected_remote_urls: pushInput.expected_remote_urls })
  };
}

function isPushSkipped(
  input: GitPushBranchInput | GitPushBranchSkippedInput
): input is GitPushBranchSkippedInput {
  return "skipped" in input && input.skipped === true;
}

export function createGitPushBranchBuiltIn(
  ports: GitBuiltInPortResolver
): BuiltInStep<"git.push_branch"> {
  return defineBuiltInStep({
    name: "git.push_branch",
    metadata: gitPushBranchMetadata,
    async run(options) {
      const input = pushInputFrom(options.input, options.state);
      if (isPushSkipped(input)) {
        return {
          ...input,
          operation_id: "git.push_branch"
        } satisfies GitPushBranchSkippedResult;
      }

      return await resolvePorts(ports, options).repository.pushBranch(input);
    }
  });
}
