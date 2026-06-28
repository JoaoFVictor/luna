import { gitCommitMetadata } from "../../core/built-ins/metadata.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import type { BuiltInStep, BuiltInStepRunOptions } from "../../core/built-ins/types.js";
import type {
  GitBuiltInPorts,
  GitCommitInput,
  GitCommitResult,
  GitCommitSkippedInput,
  GitCommitSkippedResult
} from "./contracts.js";
import {
  gitError,
  normalizedPaths,
  type GitBuiltInPortResolver,
  resolvePorts,
  workspaceFrom
} from "./shared.js";

type GitCommitBuiltInInput = {
  readonly operation_id: "git.commit";
  readonly message: string;
  readonly paths?: readonly string[];
  readonly expected_branch?: string;
  readonly expected_base_sha?: string;
  readonly remote?: string;
  readonly expected_remote_urls?: readonly string[];
};

function commitInputFrom(
  input: Record<string, unknown> | undefined,
  state: BuiltInStepRunOptions["state"]
): GitCommitInput | GitCommitSkippedInput {
  if (input?.operation_id !== undefined && input.operation_id !== "git.commit") {
    throw gitError("Git commit operation_id is invalid.", "git_input_invalid");
  }

  if (input?.skipped === true) {
    if (typeof input.enabled !== "boolean" || typeof input.reason !== "string") {
      throw gitError("Git commit skip input is invalid.", "git_input_invalid");
    }

    return {
      operation_id: "git.commit",
      enabled: input.enabled,
      skipped: true,
      reason: input.reason
    };
  }

  if (typeof input?.message !== "string" || input.message === "") {
    throw gitError("Git commit message is required.", "git_input_invalid");
  }

  if (
    input?.paths !== undefined &&
    (!Array.isArray(input.paths) ||
      input.paths.some((candidate) => typeof candidate !== "string"))
  ) {
    throw gitError("Git commit paths must be strings.", "git_input_invalid");
  }
  if (
    input?.expected_branch !== undefined &&
    typeof input.expected_branch !== "string"
  ) {
    throw gitError("Git commit expected_branch must be a string.", "git_input_invalid");
  }
  if (
    input?.expected_base_sha !== undefined &&
    typeof input.expected_base_sha !== "string"
  ) {
    throw gitError(
      "Git commit expected_base_sha must be a string.",
      "git_input_invalid"
    );
  }
  if (input?.remote !== undefined && typeof input.remote !== "string") {
    throw gitError("Git commit remote must be a string.", "git_input_invalid");
  }
  if (
    input?.expected_remote_urls !== undefined &&
    (!Array.isArray(input.expected_remote_urls) ||
      input.expected_remote_urls.some((candidate) => typeof candidate !== "string"))
  ) {
    throw gitError(
      "Git commit expected_remote_urls must be strings.",
      "git_input_invalid"
    );
  }

  const commitInput: GitCommitBuiltInInput = {
    operation_id: "git.commit",
    message: input.message,
    ...(input?.paths === undefined ? {} : { paths: input.paths }),
    ...(input?.expected_branch === undefined
      ? {}
      : { expected_branch: input.expected_branch }),
    ...(input?.expected_base_sha === undefined
      ? {}
      : { expected_base_sha: input.expected_base_sha }),
    ...(input?.remote === undefined ? {} : { remote: input.remote }),
    ...(input?.expected_remote_urls === undefined
      ? {}
      : { expected_remote_urls: input.expected_remote_urls })
  };

  return {
    ...commitInput,
    workspace: workspaceFrom(state)
  };
}

function pathsMatch(
  existingPaths: readonly string[] | undefined,
  inputPaths: readonly string[] | undefined
): boolean {
  if (inputPaths === undefined) {
    return true;
  }
  return (
    JSON.stringify(normalizedPaths(existingPaths)) ===
    JSON.stringify(normalizedPaths(inputPaths))
  );
}

function targetDirtyPaths(input: GitCommitInput): readonly string[] {
  const dirtyPaths = normalizedPaths(input.expected_dirty_paths);
  if (input.paths === undefined) {
    return dirtyPaths;
  }

  const targetPaths = new Set(normalizedPaths(input.paths));
  return dirtyPaths.filter((dirtyPath) => targetPaths.has(dirtyPath));
}

function matchesExpectedHead(
  existing: NonNullable<
    Awaited<ReturnType<GitBuiltInPorts["repository"]["readCommitState"]>>
  >,
  input: GitCommitInput
): boolean {
  if (existing.head_sha === input.expected_head_sha) {
    return true;
  }

  return (
    existing.commit_sha === input.expected_head_sha &&
    targetDirtyPaths(input).length === 0
  );
}

function compatibleCommit(
  existing: Awaited<ReturnType<GitBuiltInPorts["repository"]["readCommitState"]>>,
  input: GitCommitInput
): GitCommitResult | undefined {
  if (
    existing?.operation_id !== "git.commit" ||
    existing.commit_sha === undefined ||
    existing.workspace_id !== input.workspace.workspace_id ||
    existing.branch !== input.expected_branch ||
    !matchesExpectedHead(existing, input) ||
    existing.message !== input.message
  ) {
    return undefined;
  }

  if (!pathsMatch(existing.paths, input.paths)) {
    return undefined;
  }

  return {
    ...existing,
    commit_sha: existing.commit_sha,
    message: input.message,
    paths:
      input.paths === undefined
        ? normalizedPaths(existing.paths)
        : normalizedPaths(input.paths),
    adopted: true
  };
}

function isCommitSkipped(
  input: GitCommitInput | GitCommitSkippedInput
): input is GitCommitSkippedInput {
  return "skipped" in input && input.skipped === true;
}

export function createGitCommitBuiltIn(
  ports: GitBuiltInPortResolver
): BuiltInStep<"git.commit"> {
  return defineBuiltInStep({
    name: "git.commit",
    metadata: gitCommitMetadata,
    async run(options) {
      const initialInput = commitInputFrom(options.input, options.state);
      if (isCommitSkipped(initialInput)) {
        return {
          ...initialInput,
          operation_id: "git.commit"
        } satisfies GitCommitSkippedResult;
      }

      const repository = resolvePorts(ports, options).repository;
      const status = await repository.status({
        operation_id: "git.status",
        workspace: initialInput.workspace
      });
      const input: GitCommitInput = {
        ...initialInput,
        expected_branch: initialInput.expected_branch ?? status.branch,
        expected_head_sha: status.head_sha,
        expected_dirty_paths: normalizedPaths([
          ...status.staged_paths,
          ...status.unstaged_paths,
          ...status.untracked_paths
        ])
      };
      const existing = await repository.readCommitState(input);
      const adopted = compatibleCommit(existing, input);

      if (adopted !== undefined) {
        return adopted;
      }

      return await repository.commit(input);
    }
  });
}
