import type { ImplementationWorktreeRecord } from "../write-mode/worktree.js";
import type { RepositoryConfig } from "../config/schemas.js";
import type { WorkspaceRecord } from "../write-mode/types.js";
import type { CodeReviewFindings, Finding } from "../findings/types.js";
import type { ValidationResult } from "../validation/runner.js";
import type { ImplementationConfig } from "../write-mode/types.js";
import type { WorkflowState } from "../workflow/state.js";
import { builtInError, type BuiltInErrorCode } from "./errors.js";

export function requiredState<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw builtInError(`Built-in step requires state.${name}`, "built_in_state_missing");
  }

  return value;
}

export function requiredInput<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw builtInError(`Built-in step requires input.${name}`, "built_in_input_missing");
  }

  return value;
}

export function asRecord(
  value: unknown,
  name: string,
  code: BuiltInErrorCode
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw builtInError(`Built-in step requires ${name}`, code);
  }

  return value as Record<string, unknown>;
}

export function repositoryFrom(state: WorkflowState): RepositoryConfig {
  return requiredState(state.repository as RepositoryConfig | undefined, "repository");
}

export function workflowFrom(
  state: WorkflowState
): { mode: "read_only" | "trusted_local_write" } | undefined {
  const workflow = state.workflow as { mode?: unknown } | undefined;

  if (
    workflow?.mode === "read_only" ||
    workflow?.mode === "trusted_local_write"
  ) {
    return { mode: workflow.mode };
  }

  return undefined;
}

export function implementationFrom(
  state: WorkflowState
): ImplementationConfig["implementation"] | undefined {
  return (
    state.config as
      | { implementation?: ImplementationConfig["implementation"] }
      | undefined
  )?.implementation;
}

export function requiredImplementationFrom(
  state: WorkflowState
): ImplementationConfig["implementation"] {
  return requiredState(implementationFrom(state), "config.implementation");
}

export function runIdFrom(state: WorkflowState): string {
  const run = asRecord(
    requiredState(state.run, "run"),
    "state.run",
    "built_in_state_missing"
  );
  return requiredState(run.run_id as string | undefined, "run.run_id");
}

export function workspaceFrom(state: WorkflowState): WorkspaceRecord {
  return requiredState(state.workspace as WorkspaceRecord | undefined, "workspace");
}

export function implementationWorkspaceFrom(
  state: WorkflowState
): ImplementationWorktreeRecord {
  const workspace = workspaceFrom(state) as Partial<ImplementationWorktreeRecord>;

  requiredState(workspace.branch, "workspace.branch");
  requiredState(workspace.remote, "workspace.remote");
  requiredState(workspace.base_sha, "workspace.base_sha");

  return workspace as ImplementationWorktreeRecord;
}

export function workspaceRootFrom(state: WorkflowState): string {
  return requiredState(state.workspaceRoot, "workspaceRoot");
}

export function findingsFrom(value: unknown): readonly Finding[] {
  if (Array.isArray(value)) {
    return value as Finding[];
  }

  const findings = (value as CodeReviewFindings | undefined)?.findings;

  if (Array.isArray(findings)) {
    return findings;
  }

  return requiredInput<readonly Finding[]>(undefined, "findings.findings");
}

export function resolvedInput(
  input: Record<string, unknown> | undefined,
  _state: WorkflowState
): Record<string, unknown> {
  return input ?? {};
}

export function optionalResolvedOrStep(
  resolved: Record<string, unknown>,
  state: WorkflowState,
  inputName: string,
  stepName: string
): unknown {
  if (resolved[inputName] !== undefined) {
    return resolved[inputName];
  }

  return (state.steps as Record<string, unknown> | undefined)?.[stepName];
}

export function finalValidationFrom(
  state: WorkflowState,
  resolved: Record<string, unknown> = {}
): ValidationResult {
  const direct = optionalResolvedOrStep(resolved, state, "validation", "validation");

  if (direct !== undefined) {
    return direct as ValidationResult;
  }

  const implementation = asRecord(
    requiredState(
      (state.steps as Record<string, unknown> | undefined)?.implementation,
      "steps.implementation"
    ),
    "state.steps.implementation",
    "built_in_state_missing"
  );

  return requiredState(
    implementation.final_validation as ValidationResult | undefined,
    "steps.implementation.final_validation"
  );
}

export function stepValue<T>(
  state: WorkflowState,
  resolved: Record<string, unknown>,
  inputName: string,
  stepName: string
): T {
  return requiredState(
    optionalResolvedOrStep(resolved, state, inputName, stepName) as T | undefined,
    `steps.${stepName}`
  );
}

export function expectedRemoteUrlsFrom(repository: RepositoryConfig): readonly string[] {
  return requiredState(
    repository.expected_remote_urls,
    "repository.expected_remote_urls"
  );
}
