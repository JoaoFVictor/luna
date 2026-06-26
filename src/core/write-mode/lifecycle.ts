import type {
  BuiltInStepMetadata,
  ImplementationLifecycleOutcome
} from "../built-ins/types.js";
import type { WorkflowRuntimeState } from "../workflow/state.js";

export type ImplementationLifecycleEvidence = {
  workspaceCreated: boolean;
  implementationStarted: boolean;
  validationRan: boolean;
  validationPassed: boolean;
  diffCollectionSucceeded: boolean;
  acceptanceAccepted: boolean;
  commitAttempted: boolean;
  commitSucceeded: boolean;
  pushAttempted: boolean;
  changeRequestAttempted: boolean;
  failureReason?: {
    phase:
      | "workspace"
      | "implementation"
      | "validation"
      | "diff"
      | "commit"
      | "push"
      | "change_request";
    code: string;
    message: string;
  };
};

export type WorkflowNodeLifecycleResult = {
  status: "succeeded" | "failed" | "skipped";
  outcome?: ImplementationLifecycleOutcome;
};

export function initialImplementationLifecycleEvidence(): ImplementationLifecycleEvidence {
  return {
    workspaceCreated: false,
    implementationStarted: false,
    validationRan: false,
    validationPassed: false,
    diffCollectionSucceeded: false,
    acceptanceAccepted: false,
    commitAttempted: false,
    commitSucceeded: false,
    pushAttempted: false,
    changeRequestAttempted: false
  };
}

export function markAcceptanceAccepted(
  evidence: ImplementationLifecycleEvidence,
  accepted: boolean
): ImplementationLifecycleEvidence {
  return { ...evidence, acceptanceAccepted: accepted };
}

export function markWorkspaceCreated(
  evidence: ImplementationLifecycleEvidence
): ImplementationLifecycleEvidence {
  return { ...evidence, workspaceCreated: true };
}

export function markImplementationStarted(
  evidence: ImplementationLifecycleEvidence
): ImplementationLifecycleEvidence {
  return { ...evidence, implementationStarted: true };
}

export function markValidationResult(
  evidence: ImplementationLifecycleEvidence,
  result: { ran: boolean; passed: boolean }
): ImplementationLifecycleEvidence {
  return {
    ...evidence,
    validationRan: result.ran,
    validationPassed: result.passed
  };
}

export function markDiffCollectionResult(
  evidence: ImplementationLifecycleEvidence,
  result: { succeeded: boolean }
): ImplementationLifecycleEvidence {
  return {
    ...evidence,
    diffCollectionSucceeded: result.succeeded
  };
}

export function markCommitResult(
  evidence: ImplementationLifecycleEvidence,
  result: { attempted: boolean; succeeded: boolean }
): ImplementationLifecycleEvidence {
  return {
    ...evidence,
    commitAttempted: result.attempted,
    commitSucceeded: result.succeeded
  };
}

export function markPushAttempted(
  evidence: ImplementationLifecycleEvidence,
  attempted: boolean
): ImplementationLifecycleEvidence {
  return { ...evidence, pushAttempted: attempted };
}

export function markChangeRequestAttempted(
  evidence: ImplementationLifecycleEvidence,
  attempted: boolean
): ImplementationLifecycleEvidence {
  return { ...evidence, changeRequestAttempted: attempted };
}

export function markImplementationFailure(
  evidence: ImplementationLifecycleEvidence,
  failureReason: ImplementationLifecycleEvidence["failureReason"]
): ImplementationLifecycleEvidence {
  return failureReason === undefined ? evidence : { ...evidence, failureReason };
}

export function recordWorkflowNodeLifecycle(
  evidence: ImplementationLifecycleEvidence,
  metadata: BuiltInStepMetadata,
  result: WorkflowNodeLifecycleResult
): ImplementationLifecycleEvidence {
  const phase = metadata.implementationLifecycle;
  if (phase === undefined) {
    return evidence;
  }

  if (phase === "workspace") {
    return result.status === "succeeded" ? markWorkspaceCreated(evidence) : evidence;
  }

  if (phase === "validation") {
    const validationPassed = result.outcome?.validationPassed;
    if (
      result.status === "succeeded" &&
      validationPassed === undefined
    ) {
      throw new Error("Validation lifecycle outcome is missing validationPassed");
    }

    return markValidationResult(markImplementationStarted(evidence), {
      ran: result.status !== "skipped",
      passed: result.status === "succeeded" && validationPassed === true
    });
  }

  if (phase === "implementation") {
    if (
      result.status === "succeeded" &&
      result.outcome?.validationPassed === undefined
    ) {
      throw new Error(
        "Implementation lifecycle outcome is missing validationPassed"
      );
    }

    if (
      result.status === "succeeded" &&
      result.outcome?.acceptanceAccepted === undefined
    ) {
      throw new Error(
        "Implementation lifecycle outcome is missing acceptanceAccepted"
      );
    }

    return markAcceptanceAccepted(
      markValidationResult(markImplementationStarted(evidence), {
        ran: result.status !== "skipped",
        passed:
          result.status === "succeeded" &&
          result.outcome?.validationPassed === true
      }),
      result.status === "succeeded" &&
        result.outcome?.acceptanceAccepted === true
    );
  }

  if (phase === "diff") {
    return markDiffCollectionResult(evidence, {
      succeeded: result.status === "succeeded"
    });
  }

  if (phase === "acceptance") {
    if (
      result.status === "succeeded" &&
      result.outcome?.acceptanceAccepted === undefined
    ) {
      throw new Error("Acceptance lifecycle outcome is missing acceptanceAccepted");
    }

    return markAcceptanceAccepted(
      evidence,
      result.status === "succeeded" &&
        result.outcome?.acceptanceAccepted === true
    );
  }

  if (phase === "commit") {
    if (
      result.status === "succeeded" &&
      result.outcome?.commitSucceeded === undefined
    ) {
      throw new Error("Commit lifecycle outcome is missing commitSucceeded");
    }

    return markCommitResult(evidence, {
      attempted: result.status !== "skipped",
      succeeded:
        result.status === "succeeded" &&
        result.outcome?.commitSucceeded === true
    });
  }

  if (phase === "push") {
    if (
      result.status === "succeeded" &&
      result.outcome?.pushAttempted === undefined
    ) {
      throw new Error("Push lifecycle outcome is missing pushAttempted");
    }

    return markPushAttempted(
      evidence,
      result.status === "succeeded" && result.outcome?.pushAttempted === true
    );
  }

  if (phase === "change_request") {
    if (
      result.status === "succeeded" &&
      result.outcome?.changeRequestAttempted === undefined
    ) {
      throw new Error(
        "Change request lifecycle outcome is missing changeRequestAttempted"
      );
    }

    return markChangeRequestAttempted(
      evidence,
      result.status === "succeeded" &&
        result.outcome?.changeRequestAttempted === true
    );
  }

  return evidence;
}

export function lifecycleEvidenceFromWorkflowState(
  state: { lifecycleEvidence?: WorkflowRuntimeState["lifecycleEvidence"] }
): ImplementationLifecycleEvidence {
  return state.lifecycleEvidence ?? initialImplementationLifecycleEvidence();
}
