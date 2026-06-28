import { z } from "zod";
import type { BuiltInStepMetadata } from "../../core/built-ins/types.js";
import { AcceptanceDecisionSchema } from "../../core/decisions/types.js";
import { ValidationResultSchema } from "../../core/validation/types.js";
import {
  CommitChangesArtifactSchema,
  PushBranchArtifactSchema
} from "./types.js";

function lifecycleContractError(message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = "built_in_lifecycle_contract_invalid";

  return error;
}

function repositoryLock(): { resource: "repository"; mode: "exclusive" } {
  return { resource: "repository", mode: "exclusive" };
}

export const prepareImplementationWorktreeMetadata = Object.freeze({
  implementationLifecycle: "workspace",
  capturesWorkspace: true,
  requiresRepository: true,
  locks: Object.freeze([repositoryLock()])
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
