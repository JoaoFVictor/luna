import { describe, expect, it } from "vitest";
import {
  initialImplementationLifecycleEvidence,
  recordWorkflowNodeLifecycle
} from "../../src/capabilities/repository-change/lifecycle.js";

describe("implementation lifecycle evidence", () => {
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
