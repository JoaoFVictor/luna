import type {
  BuiltInStepDependencies,
  BuiltInStepRunOptions
} from "../../core/built-ins/types.js";
import type { RepositoryWorkspaceRecord } from "../repository-workspace/contracts.js";
import type { GitBuiltInPorts } from "./contracts.js";

export type GitBuiltInPortResolver =
  | GitBuiltInPorts
  | ((options: BuiltInStepRunOptions) => GitBuiltInPorts);

export type GitBuiltInDependencies = BuiltInStepDependencies & {
  readonly git?: GitBuiltInPorts;
};

export function gitError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function resolvePorts(
  resolver: GitBuiltInPortResolver,
  options: BuiltInStepRunOptions
): GitBuiltInPorts {
  return typeof resolver === "function" ? resolver(options) : resolver;
}

export function gitPortsFromBuiltInOptions({
  dependencies = {}
}: BuiltInStepRunOptions<GitBuiltInDependencies>): GitBuiltInPorts {
  if (dependencies.git === undefined) {
    throw gitError(
      "Git ports are not configured for this runtime.",
      "git_port_unavailable"
    );
  }

  return dependencies.git;
}

export function workspaceFrom(state: { workspace?: unknown }): RepositoryWorkspaceRecord {
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

export function normalizedPaths(paths: readonly string[] | undefined): readonly string[] {
  return [...new Set(paths ?? [])].sort();
}
