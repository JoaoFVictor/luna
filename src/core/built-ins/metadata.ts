import { ChangeRequestArtifactSchema } from "../change-request/contracts.js";
import { AcceptanceDecisionSchema } from "../decisions/types.js";
import { ValidationResultSchema } from "../validation/runner.js";
import {
  CommitChangesArtifactSchema,
  PushBranchArtifactSchema
} from "../write-mode/types.js";
import type { BuiltInStepMetadata } from "./types.js";

function lifecycleContractError(message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = "built_in_lifecycle_contract_invalid";

  return error;
}

function repositoryLock(): { resource: "repository"; mode: "exclusive" } {
  return { resource: "repository", mode: "exclusive" };
}

export const emptyBuiltInMetadata = Object.freeze({});

export const prepareWorktreeMetadata = Object.freeze({
  capturesWorkspace: true,
  locks: Object.freeze([repositoryLock()])
} satisfies BuiltInStepMetadata);

export const finalReportMetadata = Object.freeze({
  deferredLifecycle: "final_report"
} satisfies BuiltInStepMetadata);

export const prepareImplementationWorktreeMetadata = Object.freeze({
  implementationLifecycle: "workspace",
  capturesWorkspace: true,
  locks: Object.freeze([repositoryLock()])
} satisfies BuiltInStepMetadata);

export const runValidationCommandsMetadata = Object.freeze({
  implementationLifecycle: "validation",
  implementationLifecycleOutcome: (output) => {
    const result = ValidationResultSchema.safeParse(output);
    if (!result.success) {
      throw lifecycleContractError(
        "run_validation_commands must return ValidationResult"
      );
    }

    return { validationPassed: result.data.passed };
  }
} satisfies BuiltInStepMetadata);

export const recordImplementationValidationMetadata = Object.freeze({
  implementationLifecycle: "validation",
  implementationLifecycleOutcome: (output) => {
    const result = ValidationResultSchema.safeParse(output);
    if (!result.success) {
      throw lifecycleContractError(
        "record_implementation_validation must return ValidationResult"
      );
    }

    return { validationPassed: result.data.passed };
  }
} satisfies BuiltInStepMetadata);

export const collectWorktreeDiffMetadata = Object.freeze({
  implementationLifecycle: "diff"
} satisfies BuiltInStepMetadata);

export const recordAcceptanceDecisionMetadata = Object.freeze({
  implementationLifecycle: "acceptance",
  implementationLifecycleOutcome: (output) => {
    const result = AcceptanceDecisionSchema.safeParse(output);
    if (!result.success) {
      throw lifecycleContractError(
        "record_acceptance_decision must return AcceptanceDecision"
      );
    }

    return { acceptanceAccepted: result.data.status === "accepted" };
  }
} satisfies BuiltInStepMetadata);

export const commitChangesMetadata = Object.freeze({
  implementationLifecycle: "commit",
  implementationLifecycleOutcome: (output) => {
    const result = CommitChangesArtifactSchema.safeParse(output);
    if (!result.success) {
      throw lifecycleContractError("commit_changes must return CommitChangesArtifact");
    }

    return {
      commitSucceeded:
        !result.data.skipped && result.data.commit_sha !== undefined
    };
  },
  locks: Object.freeze([repositoryLock()])
} satisfies BuiltInStepMetadata);

export const pushBranchMetadata = Object.freeze({
  implementationLifecycle: "push",
  implementationLifecycleOutcome: (output) => {
    const result = PushBranchArtifactSchema.safeParse(output);
    if (!result.success) {
      throw lifecycleContractError("push_branch must return PushBranchArtifact");
    }

    return {
      pushAttempted:
        !result.data.skipped &&
        result.data.remote !== undefined &&
        result.data.branch !== undefined
    };
  },
  locks: Object.freeze([repositoryLock()])
} satisfies BuiltInStepMetadata);

export const openChangeRequestMetadata = Object.freeze({
  implementationLifecycle: "change_request",
  implementationLifecycleOutcome: (output) => {
    const result = ChangeRequestArtifactSchema.safeParse(output);
    if (!result.success) {
      throw lifecycleContractError(
        "open_change_request must return ChangeRequestArtifact"
      );
    }

    return {
      changeRequestAttempted:
        !result.data.skipped && result.data.url !== undefined
    };
  },
  locks: Object.freeze([repositoryLock()])
} satisfies BuiltInStepMetadata);

export const builtInStepMetadataByName = Object.freeze({
  preflight: emptyBuiltInMetadata,
  prepare_worktree: prepareWorktreeMetadata,
  collect_context: emptyBuiltInMetadata,
  collect_repo_context: emptyBuiltInMetadata,
  validate_code_review_findings: emptyBuiltInMetadata,
  final_code_review_report: finalReportMetadata,
  prepare_implementation_worktree: prepareImplementationWorktreeMetadata,
  collect_task_context: emptyBuiltInMetadata,
  run_validation_commands: runValidationCommandsMetadata,
  record_implementation_validation: recordImplementationValidationMetadata,
  collect_worktree_diff: collectWorktreeDiffMetadata,
  record_acceptance_decision: recordAcceptanceDecisionMetadata,
  commit_changes: commitChangesMetadata,
  push_branch: pushBranchMetadata,
  open_change_request: openChangeRequestMetadata,
  final_implementation_report: finalReportMetadata
});
