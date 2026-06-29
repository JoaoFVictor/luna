import type { RepositoryConfig } from "../config/schemas.js";
import type { Finding, FindingsPayload } from "../findings/types.js";
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

export function implementationFrom<T = unknown>(state: WorkflowState): T | undefined {
  return (state.config as { implementation?: T } | undefined)?.implementation;
}

export function runIdFrom(state: WorkflowState): string {
  const run = asRecord(
    requiredState(state.run, "run"),
    "state.run",
    "built_in_state_missing"
  );
  return requiredState(run.run_id as string | undefined, "run.run_id");
}

export function workspaceFrom<T = { path: string }>(state: WorkflowState): T {
  return requiredState(state.workspace as T | undefined, "workspace");
}

export function workspaceRootFrom(state: WorkflowState): string {
  return requiredState(state.workspaceRoot, "workspaceRoot");
}

export function findingsFrom(value: unknown): readonly Finding[] {
  if (Array.isArray(value)) {
    return value as Finding[];
  }

  const findings = (value as FindingsPayload | undefined)?.findings;

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
