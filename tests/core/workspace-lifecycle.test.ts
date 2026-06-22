import { describe, expect, it } from "vitest";
import {
  initialImplementationLifecycleEvidence,
  markCommitResult,
  markValidationResult,
  recordWorkflowNodeLifecycle,
  type ImplementationLifecycleEvidence
} from "../../src/core/write-mode/lifecycle.js";
import { workspaceLifecycleDecision } from "../../src/core/write-mode/workspace-lifecycle.js";

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
    acceptanceAccepted: true,
    commitAttempted: true,
    commitSucceeded: true,
    ...overrides
  };
}

const successfulInput = {
  commitEnabled: true,
  pushEnabled: false,
  changeRequestEnabled: false,
  evidence: evidence()
};

function lifecycleDecision(input: typeof successfulInput): {
  preserve: boolean;
  reason: string;
} {
  return workspaceLifecycleDecision(input.evidence, input);
}

describe("workspace lifecycle", () => {
  it("preserves the workspace when commit is disabled", () => {
    expect(
      lifecycleDecision({
        ...successfulInput,
        commitEnabled: false
      })
    ).toEqual({ preserve: true, reason: "commit_disabled" });
  });

  it("preserves the workspace when validation failed", () => {
    expect(
      lifecycleDecision({
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
      lifecycleDecision({
        ...successfulInput,
        evidence: evidence({ acceptanceAccepted: false })
      })
    ).toEqual({ preserve: true, reason: "acceptance_failed" });
  });

  it("preserves the workspace when push failed", () => {
    expect(
      lifecycleDecision({
        ...successfulInput,
        pushEnabled: true,
        evidence: evidence({ pushAttempted: false })
      })
    ).toEqual({ preserve: true, reason: "push_skipped_or_failed" });
  });

  it("preserves the workspace when PR failed", () => {
    expect(
      lifecycleDecision({
        ...successfulInput,
        changeRequestEnabled: true,
        evidence: evidence({
          pushAttempted: true,
          changeRequestAttempted: false
        })
      })
    ).toEqual({ preserve: true, reason: "change_request_skipped_or_failed" });
  });

  it("allows cleanup when all enabled gates succeeded", () => {
    expect(lifecycleDecision(successfulInput)).toEqual({
      preserve: false,
      reason: "success_cleanup"
    });
  });

  it("allows cleanup when commit is enabled and push and PR are disabled after acceptance", () => {
    expect(
      lifecycleDecision({
        ...successfulInput,
        evidence: evidence({
          pushAttempted: false,
          changeRequestAttempted: false
        })
      })
    ).toEqual({ preserve: false, reason: "success_cleanup" });
  });

  it("updates lifecycle evidence through typed helpers", () => {
    const afterValidation = recordWorkflowNodeLifecycle(
      initialImplementationLifecycleEvidence(),
      { implementationLifecycle: "validation" },
      { status: "succeeded", outcome: { validationPassed: true } }
    );
    const afterCommit = recordWorkflowNodeLifecycle(
      afterValidation,
      { implementationLifecycle: "commit" },
      { status: "succeeded", outcome: { commitSucceeded: false } }
    );

    expect(afterCommit).toMatchObject({
      implementationStarted: true,
      validationRan: true,
      validationPassed: true,
      commitAttempted: true,
      commitSucceeded: false
    });

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

  it("records implementation checkpoint evidence atomically", () => {
    const afterImplementation = recordWorkflowNodeLifecycle(
      initialImplementationLifecycleEvidence(),
      { implementationLifecycle: "implementation" },
      {
        status: "succeeded",
        outcome: {
          validationPassed: true,
          acceptanceAccepted: true
        }
      }
    );

    expect(afterImplementation).toMatchObject({
      implementationStarted: true,
      validationRan: true,
      validationPassed: true,
      acceptanceAccepted: true
    });
  });

});
