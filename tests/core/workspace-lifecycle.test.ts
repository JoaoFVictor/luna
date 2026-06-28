import { describe, expect, it } from "vitest";
import {
  initialImplementationLifecycleEvidence,
  recordWorkflowNodeLifecycle,
  type ImplementationLifecycleEvidence
} from "../../src/capabilities/repository-change/lifecycle.js";
import { workspaceLifecycleDecision } from "../../src/capabilities/repository-change/workspace-lifecycle.js";

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
  it("preserves the workspace when validation failed", () => {
    expect(
      lifecycleDecision({
        ...successfulInput,
        evidence: evidence({
          validationRan: true,
          validationPassed: false
        })
      })
    ).toEqual({ preserve: true, reason: "validation_failed" });
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
