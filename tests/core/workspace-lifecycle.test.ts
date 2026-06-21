import { describe, expect, it } from "vitest";
import {
  initialImplementationLifecycleEvidence,
  markCommitResult,
  markValidationResult,
  type ImplementationLifecycleEvidence
} from "../../src/core/implementation-lifecycle.js";
import { shouldPreserveWriteWorkspace } from "../../src/core/workspace-lifecycle.js";

function evidence(
  overrides: Partial<ImplementationLifecycleEvidence> = {}
): ImplementationLifecycleEvidence {
  return {
    ...initialImplementationLifecycleEvidence(),
    workspaceCreated: true,
    implementationStarted: true,
    validationRan: true,
    validationPassed: true,
    diffCollectionSucceeded: true,
    commitAttempted: true,
    commitSucceeded: true,
    ...overrides
  };
}

const successfulInput = {
  commitEnabled: true,
  pushEnabled: false,
  pullRequestEnabled: false,
  acceptanceAccepted: true,
  evidence: evidence()
};

describe("workspace lifecycle", () => {
  it("preserves the workspace when commit is disabled", () => {
    expect(
      shouldPreserveWriteWorkspace({
        ...successfulInput,
        commitEnabled: false
      })
    ).toEqual({ preserve: true, reason: "commit_disabled" });
  });

  it("preserves the workspace when validation failed", () => {
    expect(
      shouldPreserveWriteWorkspace({
        ...successfulInput,
        evidence: evidence({
          validationRan: true,
          validationPassed: false,
          failureReason: {
            phase: "validation",
            code: "validation_failed",
            message: "Validation failed"
          }
        })
      })
    ).toEqual({ preserve: true, reason: "validation_failed" });
  });

  it("preserves the workspace when acceptance failed", () => {
    expect(
      shouldPreserveWriteWorkspace({
        ...successfulInput,
        acceptanceAccepted: false
      })
    ).toEqual({ preserve: true, reason: "acceptance_failed" });
  });

  it("preserves the workspace when push failed", () => {
    expect(
      shouldPreserveWriteWorkspace({
        ...successfulInput,
        pushEnabled: true,
        evidence: evidence({ pushAttempted: false })
      })
    ).toEqual({ preserve: true, reason: "push_skipped_or_failed" });
  });

  it("preserves the workspace when PR failed", () => {
    expect(
      shouldPreserveWriteWorkspace({
        ...successfulInput,
        pullRequestEnabled: true,
        evidence: evidence({
          pushAttempted: true,
          pullRequestAttempted: false
        })
      })
    ).toEqual({ preserve: true, reason: "pull_request_skipped_or_failed" });
  });

  it("allows cleanup when all enabled gates succeeded", () => {
    expect(shouldPreserveWriteWorkspace(successfulInput)).toEqual({
      preserve: false,
      reason: "success_cleanup"
    });
  });

  it("allows cleanup when commit is enabled and push and PR are disabled after acceptance", () => {
    expect(
      shouldPreserveWriteWorkspace({
        ...successfulInput,
        evidence: evidence({
          pushAttempted: false,
          pullRequestAttempted: false
        })
      })
    ).toEqual({ preserve: false, reason: "success_cleanup" });
  });

  it("updates lifecycle evidence through typed helpers", () => {
    expect(
      markCommitResult(
        markValidationResult(initialImplementationLifecycleEvidence(), {
          ran: true,
          passed: true
        }),
        { attempted: true, succeeded: false }
      )
    ).toMatchObject({
      validationRan: true,
      validationPassed: true,
      commitAttempted: true,
      commitSucceeded: false
    });
  });
});
