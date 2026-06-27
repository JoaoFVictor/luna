import { ChangeRequestArtifactSchema } from "../change-request/contracts.js";
import { AcceptanceDecisionSchema } from "../decisions/types.js";
import { ValidationResultSchema } from "../validation/runner.js";
import {
  CommitChangesArtifactSchema,
  PushBranchArtifactSchema
} from "../write-mode/types.js";
import type { BuiltInStepMetadata } from "./types.js";
import { z } from "zod";

function lifecycleContractError(message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = "built_in_lifecycle_contract_invalid";

  return error;
}

function repositoryLock(): { resource: "repository"; mode: "exclusive" } {
  return { resource: "repository", mode: "exclusive" };
}

export const emptyBuiltInMetadata = Object.freeze({});

export const repositoryRequiredMetadata = Object.freeze({
  requiresRepository: true
} satisfies BuiltInStepMetadata);

export const prepareWorktreeMetadata = Object.freeze({
  capturesWorkspace: true,
  requiresRepository: true,
  locks: Object.freeze([repositoryLock()])
} satisfies BuiltInStepMetadata);

export const finalReportMetadata = Object.freeze({
  deferredLifecycle: "final_report"
} satisfies BuiltInStepMetadata);

export const prepareImplementationWorktreeMetadata = Object.freeze({
  implementationLifecycle: "workspace",
  capturesWorkspace: true,
  requiresRepository: true,
  locks: Object.freeze([repositoryLock()])
} satisfies BuiltInStepMetadata);

export const repositoryWorkspaceCaptureMetadata = Object.freeze({
  capturesWorkspace: true,
  requiresRepository: true
} satisfies BuiltInStepMetadata);

export const gitStatusMetadata = Object.freeze({
  requiresRepository: true
} satisfies BuiltInStepMetadata);

export const gitCommitMetadata = Object.freeze({
  requiresRepository: true,
  locks: Object.freeze([repositoryLock()])
} satisfies BuiltInStepMetadata);

export const gitPushBranchMetadata = Object.freeze({
  requiresRepository: true,
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

const ImplementationValidationRecordSchema = z
  .object({
    validation: ValidationResultSchema,
    acceptance: AcceptanceDecisionSchema
  })
  .strict();

export const recordImplementationValidationMetadata = Object.freeze({
  implementationLifecycle: "implementation",
  implementationLifecycleOutcome: (output) => {
    const record = ImplementationValidationRecordSchema.safeParse(output);
    if (record.success) {
      return {
        validationPassed: record.data.validation.passed,
        acceptanceAccepted: record.data.acceptance.status === "accepted"
      };
    }

    throw lifecycleContractError(
      "record_implementation_validation must return ImplementationValidationRecord"
    );
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

export const commitLifecycleArtifactMetadata = Object.freeze({
  implementationLifecycle: "commit",
  requiresRepository: true,
  implementationLifecycleOutcome: (output) => {
    const result = CommitChangesArtifactSchema.safeParse(output);
    if (!result.success) {
      throw lifecycleContractError(
        "record_commit_lifecycle must return CommitChangesArtifact"
      );
    }

    return {
      commitSucceeded:
        !result.data.skipped && result.data.commit_sha !== undefined
    };
  },
  locks: Object.freeze([repositoryLock()])
} satisfies BuiltInStepMetadata);

export const recordCommitLifecycleMetadata = Object.freeze({
  implementationLifecycle: "commit",
  implementationLifecycleOutcome:
    commitLifecycleArtifactMetadata.implementationLifecycleOutcome
} satisfies BuiltInStepMetadata);

export const pushLifecycleArtifactMetadata = Object.freeze({
  implementationLifecycle: "push",
  requiresRepository: true,
  implementationLifecycleOutcome: (output) => {
    const result = PushBranchArtifactSchema.safeParse(output);
    if (!result.success) {
      throw lifecycleContractError(
        "record_push_lifecycle must return PushBranchArtifact"
      );
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

export const recordPushLifecycleMetadata = Object.freeze({
  implementationLifecycle: "push",
  implementationLifecycleOutcome:
    pushLifecycleArtifactMetadata.implementationLifecycleOutcome
} satisfies BuiltInStepMetadata);

export const changeRequestCreateMetadata = Object.freeze({
  implementationLifecycle: "change_request",
  requiresRepository: true,
  implementationLifecycleOutcome: (output) => {
    const result = ChangeRequestArtifactSchema.safeParse(output);
    if (!result.success) {
      throw lifecycleContractError(
        "change-request.create must return ChangeRequestArtifact"
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
  preflight: repositoryRequiredMetadata,
  prepare_worktree: prepareWorktreeMetadata,
  collect_context: repositoryRequiredMetadata,
  collect_repo_context: repositoryRequiredMetadata,
  validate_code_review_findings: emptyBuiltInMetadata,
  final_code_review_report: finalReportMetadata,
  final_report: finalReportMetadata,
  "local-exec.command.read": emptyBuiltInMetadata,
  "local-exec.command.write": emptyBuiltInMetadata,
  "repository-workspace.capture": repositoryWorkspaceCaptureMetadata,
  "git.status": gitStatusMetadata,
  "git.commit": gitCommitMetadata,
  "git.push_branch": gitPushBranchMetadata,
  "change-request.create": changeRequestCreateMetadata,
  prepare_implementation_worktree: prepareImplementationWorktreeMetadata,
  collect_task_context: emptyBuiltInMetadata,
  run_validation_commands: runValidationCommandsMetadata,
  record_implementation_validation: recordImplementationValidationMetadata,
  collect_worktree_diff: collectWorktreeDiffMetadata,
  record_acceptance_decision: recordAcceptanceDecisionMetadata,
  prepare_commit: emptyBuiltInMetadata,
  record_commit_lifecycle: recordCommitLifecycleMetadata,
  prepare_push: emptyBuiltInMetadata,
  record_push_lifecycle: recordPushLifecycleMetadata,
  final_implementation_report: finalReportMetadata
});
