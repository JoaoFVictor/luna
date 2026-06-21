export type ImplementationLifecycleEvidence = {
  workspaceCreated: boolean;
  implementationStarted: boolean;
  validationRan: boolean;
  validationPassed: boolean;
  diffCollectionSucceeded: boolean;
  commitAttempted: boolean;
  commitSucceeded: boolean;
  pushAttempted: boolean;
  pullRequestAttempted: boolean;
  failureReason?: {
    phase:
      | "workspace"
      | "implementation"
      | "validation"
      | "diff"
      | "commit"
      | "push"
      | "pull_request";
    code: string;
    message: string;
  };
};

export type ImplementationLifecycleEvidenceSource = {
  workspaceCreated: boolean;
  steps: Record<string, unknown>;
  gates: {
    commitEnabled: boolean;
    pushEnabled: boolean;
    pullRequestEnabled: boolean;
  };
};

export function initialImplementationLifecycleEvidence(): ImplementationLifecycleEvidence {
  return {
    workspaceCreated: false,
    implementationStarted: false,
    validationRan: false,
    validationPassed: false,
    diffCollectionSucceeded: false,
    commitAttempted: false,
    commitSucceeded: false,
    pushAttempted: false,
    pullRequestAttempted: false
  };
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

export function markPullRequestAttempted(
  evidence: ImplementationLifecycleEvidence,
  attempted: boolean
): ImplementationLifecycleEvidence {
  return { ...evidence, pullRequestAttempted: attempted };
}

export function markImplementationFailure(
  evidence: ImplementationLifecycleEvidence,
  failureReason: ImplementationLifecycleEvidence["failureReason"]
): ImplementationLifecycleEvidence {
  return failureReason === undefined ? evidence : { ...evidence, failureReason };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function booleanAt(
  value: unknown,
  pathSegments: readonly string[]
): boolean | undefined {
  let current = value;

  for (const segment of pathSegments) {
    const record = recordValue(current);
    if (record === undefined) {
      return undefined;
    }

    current = record[segment];
  }

  return typeof current === "boolean" ? current : undefined;
}

function validationPassedFromSteps(steps: Record<string, unknown>): boolean {
  for (const value of Object.values(steps)) {
    const passed =
      booleanAt(value, ["final_validation", "passed"]) ??
      booleanAt(value, ["validation", "passed"]) ??
      booleanAt(value, ["passed"]);

    if (passed !== undefined) {
      return passed;
    }
  }

  return false;
}

function validationRanFromSteps(steps: Record<string, unknown>): boolean {
  for (const value of Object.values(steps)) {
    if (
      booleanAt(value, ["final_validation", "passed"]) !== undefined ||
      booleanAt(value, ["validation", "passed"]) !== undefined ||
      booleanAt(value, ["passed"]) !== undefined
    ) {
      return true;
    }
  }

  return false;
}

function diffCollectionSucceededFromSteps(
  steps: Record<string, unknown>
): boolean {
  const diff = recordValue(steps.diff ?? steps.collect_worktree_diff);

  if (diff === undefined) {
    return false;
  }

  return diff.status !== "failed";
}

function gateSkippedOrFailed(gateEnabled: boolean, value: unknown): boolean {
  if (!gateEnabled) {
    return false;
  }

  const record = recordValue(value);
  if (record === undefined) {
    return true;
  }

  return record.skipped === true || record.status === "failed";
}

function gateAttemptedWithSuccessEvidence(
  gateEnabled: boolean,
  value: unknown,
  hasSuccessEvidence: (record: Record<string, unknown>) => boolean
): boolean {
  if (!gateEnabled) {
    return false;
  }

  const record = recordValue(value);
  if (record === undefined || record.skipped === true || record.status === "failed") {
    return false;
  }

  return hasSuccessEvidence(record);
}

function commitAttemptedFromSteps(gateEnabled: boolean, value: unknown): boolean {
  return gateEnabled && recordValue(value) !== undefined;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function gateSkippedOrFailedWithoutEvidence(
  gateEnabled: boolean,
  value: unknown,
  hasSuccessEvidence: (record: Record<string, unknown>) => boolean
): boolean {
  if (!gateEnabled) {
    return false;
  }

  if (gateSkippedOrFailed(gateEnabled, value)) {
    return true;
  }

  const record = recordValue(value);
  return record === undefined || !hasSuccessEvidence(record);
}

function commitSkippedOrFailed(gateEnabled: boolean, value: unknown): boolean {
  return gateSkippedOrFailedWithoutEvidence(gateEnabled, value, (record) =>
    nonEmptyString(record.commit_sha)
  );
}

function pushAttemptedFromSteps(gateEnabled: boolean, value: unknown): boolean {
  return gateAttemptedWithSuccessEvidence(gateEnabled, value, (record) => {
    if (record.pushed === true) {
      return true;
    }

    return (
      nonEmptyString(record.remote) &&
      (nonEmptyString(record.branch) || nonEmptyString(record.ref))
    );
  });
}

function pullRequestAttemptedFromSteps(
  gateEnabled: boolean,
  value: unknown
): boolean {
  return gateAttemptedWithSuccessEvidence(
    gateEnabled,
    value,
    (record) => nonEmptyString(record.url) || positiveInteger(record.number)
  );
}

export function implementationLifecycleEvidenceFromSteps({
  workspaceCreated,
  steps,
  gates
}: ImplementationLifecycleEvidenceSource): ImplementationLifecycleEvidence {
  let evidence = initialImplementationLifecycleEvidence();

  if (workspaceCreated) {
    evidence = markWorkspaceCreated(evidence);
  }

  if (
    steps.implementation !== undefined ||
    steps.validation !== undefined ||
    steps.commit !== undefined ||
    steps.commit_changes !== undefined
  ) {
    evidence = markImplementationStarted(evidence);
  }

  evidence = markValidationResult(evidence, {
    ran: validationRanFromSteps(steps),
    passed: validationPassedFromSteps(steps)
  });
  evidence = markDiffCollectionResult(evidence, {
    succeeded: diffCollectionSucceededFromSteps(steps)
  });
  evidence = markCommitResult(evidence, {
    attempted: commitAttemptedFromSteps(
      gates.commitEnabled,
      steps.commit ?? steps.commit_changes
    ),
    succeeded: !commitSkippedOrFailed(
      gates.commitEnabled,
      steps.commit ?? steps.commit_changes
    )
  });
  evidence = markPushAttempted(
    evidence,
    pushAttemptedFromSteps(gates.pushEnabled, steps.push ?? steps.push_branch)
  );
  evidence = markPullRequestAttempted(
    evidence,
    pullRequestAttemptedFromSteps(
      gates.pullRequestEnabled,
      steps.pull_request ?? steps.open_pull_request
    )
  );

  return evidence;
}
