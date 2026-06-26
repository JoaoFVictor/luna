import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import {
  gitCommitMetadata,
  gitPushBranchMetadata,
  gitStatusMetadata
} from "../../core/built-ins/metadata.js";
import type {
  BuiltInStep,
  BuiltInStepRunOptions
} from "../../core/built-ins/types.js";
import type { RepositoryWorkspaceRecord } from "../repository-workspace/contracts.js";
import type {
  GitBuiltInPorts,
  GitCommitInput,
  GitCommitResult,
  GitPushBranchInput,
  GitStatusInput
} from "./contracts.js";

export type GitBuiltInPortResolver =
  | GitBuiltInPorts
  | ((options: BuiltInStepRunOptions) => GitBuiltInPorts);

type GitStatusBuiltInInput = {
  readonly operation_id: "git.status";
};

type GitCommitBuiltInInput = {
  readonly operation_id: "git.commit";
  readonly message: string;
  readonly paths?: readonly string[];
};

type GitPushBranchBuiltInInput = {
  readonly operation_id: "git.push_branch";
  readonly branch: string;
  readonly remote: string;
  readonly expected_commit_sha: string;
};

function gitError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function resolvePorts(
  resolver: GitBuiltInPortResolver,
  options: BuiltInStepRunOptions
): GitBuiltInPorts {
  return typeof resolver === "function" ? resolver(options) : resolver;
}

export function gitPortsFromBuiltInOptions({
  dependencies = {}
}: BuiltInStepRunOptions): GitBuiltInPorts {
  const { git } = dependencies;

  if (git === undefined) {
    throw gitError(
      "Git ports are not configured for this runtime.",
      "git_port_unavailable"
    );
  }

  return git;
}

function workspaceFrom(state: { workspace?: unknown }): RepositoryWorkspaceRecord {
  const candidate = state.workspace as Partial<RepositoryWorkspaceRecord> | undefined;

  if (!isRepositoryWorkspaceRecord(candidate)) {
    throw gitError(
      "Git built-ins require a captured repository workspace.",
      "git_workspace_unavailable"
    );
  }

  return candidate;
}

function isRepositoryWorkspaceRecord(
  candidate: Partial<RepositoryWorkspaceRecord> | undefined
): candidate is RepositoryWorkspaceRecord {
  return (
    candidate?.operation_id === "repository-workspace.capture" &&
    typeof candidate.run_id === "string" &&
    typeof candidate.repository_id === "string" &&
    typeof candidate.workspace_id === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.preserved === "boolean" &&
    typeof candidate.reason === "string" &&
    typeof candidate.lifecycle === "string" &&
    typeof candidate.captured_at === "string"
  );
}

function statusInputFrom(
  input: Record<string, unknown> | undefined,
  state: BuiltInStepRunOptions["state"]
): GitStatusInput {
  if (input?.operation_id !== undefined && input.operation_id !== "git.status") {
    throw gitError("Git status operation_id is invalid.", "git_input_invalid");
  }

  const statusInput: GitStatusBuiltInInput = {
    operation_id: "git.status"
  };

  return {
    ...statusInput,
    workspace: workspaceFrom(state)
  };
}

function commitInputFrom(
  input: Record<string, unknown> | undefined,
  state: BuiltInStepRunOptions["state"]
): GitCommitInput {
  if (input?.operation_id !== undefined && input.operation_id !== "git.commit") {
    throw gitError("Git commit operation_id is invalid.", "git_input_invalid");
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

  const commitInput: GitCommitBuiltInInput = {
    operation_id: "git.commit",
    message: input.message,
    ...(input?.paths === undefined ? {} : { paths: input.paths })
  };

  return {
    ...commitInput,
    workspace: workspaceFrom(state)
  };
}

function pushInputFrom(
  input: Record<string, unknown> | undefined,
  state: BuiltInStepRunOptions["state"]
): GitPushBranchInput {
  if (
    input?.operation_id !== undefined &&
    input.operation_id !== "git.push_branch"
  ) {
    throw gitError("Git push operation_id is invalid.", "git_input_invalid");
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

  const pushInput: GitPushBranchBuiltInInput = {
    operation_id: "git.push_branch",
    branch,
    remote,
    expected_commit_sha: expectedCommitSha
  };

  return {
    operation_id: pushInput.operation_id,
    workspace: workspaceFrom(state),
    branch: pushInput.branch,
    remote: pushInput.remote,
    expected_commit_sha: pushInput.expected_commit_sha
  };
}

function normalizedPaths(paths: readonly string[] | undefined): readonly string[] {
  return [...new Set(paths ?? [])].sort();
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

export function createGitStatusBuiltIn(
  ports: GitBuiltInPortResolver
): BuiltInStep<"git.status"> {
  return defineBuiltInStep({
    name: "git.status",
    metadata: gitStatusMetadata,
    async run(options) {
      const input = statusInputFrom(options.input, options.state);
      return await resolvePorts(ports, options).repository.status(input);
    }
  });
}

export function createGitCommitBuiltIn(
  ports: GitBuiltInPortResolver
): BuiltInStep<"git.commit"> {
  return defineBuiltInStep({
    name: "git.commit",
    metadata: gitCommitMetadata,
    async run(options) {
      const repository = resolvePorts(ports, options).repository;
      const initialInput = commitInputFrom(options.input, options.state);
      const status = await repository.status({
        operation_id: "git.status",
        workspace: initialInput.workspace
      });
      const input: GitCommitInput = {
        ...initialInput,
        expected_branch: status.branch,
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

export function createGitPushBranchBuiltIn(
  ports: GitBuiltInPortResolver
): BuiltInStep<"git.push_branch"> {
  return defineBuiltInStep({
    name: "git.push_branch",
    metadata: gitPushBranchMetadata,
    async run(options) {
      const input = pushInputFrom(options.input, options.state);
      return await resolvePorts(ports, options).repository.pushBranch(input);
    }
  });
}
