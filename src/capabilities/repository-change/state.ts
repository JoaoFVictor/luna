import type { RepositoryConfig } from "../../core/config/schemas.js";
import type { WorkflowState } from "../../core/workflow/state.js";
import {
  asRecord,
  implementationFrom,
  optionalResolvedOrStep,
  requiredState,
  workspaceFrom
} from "../../core/built-ins/state.js";
import type { ValidationResult } from "../validation/command-runner.js";
import type { ImplementationConfig } from "./types.js";
import type { ImplementationWorktreeRecord } from "./worktree.js";

export function requiredImplementationFrom(
  state: WorkflowState
): ImplementationConfig["implementation"] {
  return requiredState(
    implementationFrom<ImplementationConfig["implementation"]>(state),
    "config.implementation"
  );
}

export function implementationWorkspaceFrom(
  state: WorkflowState
): ImplementationWorktreeRecord {
  const workspace = workspaceFrom<Partial<ImplementationWorktreeRecord>>(state);

  requiredState(workspace.branch, "workspace.branch");
  requiredState(workspace.remote, "workspace.remote");
  requiredState(workspace.base_sha, "workspace.base_sha");

  return workspace as ImplementationWorktreeRecord;
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

export function expectedRemoteUrlsFrom(repository: RepositoryConfig): readonly string[] {
  return requiredState(
    repository.expected_remote_urls,
    "repository.expected_remote_urls"
  );
}
