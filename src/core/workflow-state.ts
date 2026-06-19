export type WorkflowState = {
  invocation: unknown;
  repository?: unknown;
  run?: unknown;
  workspace?: unknown;
  workspaceRoot?: string;
  reportPath?: string;
  steps: Record<string, unknown>;
};

function workflowStateError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function resolveReference(reference: string, state: WorkflowState): unknown {
  if (reference === "$.invocation") {
    return state.invocation;
  }

  if (reference === "$.repository") {
    if (state.repository === undefined) {
      throw workflowStateError(
        "Workflow input references missing repository",
        "workflow_reference_missing"
      );
    }

    return state.repository;
  }

  if (reference === "$.run") {
    if (state.run === undefined) {
      throw workflowStateError(
        "Workflow input references missing run",
        "workflow_reference_missing"
      );
    }

    return state.run;
  }

  if (reference === "$.workspace") {
    if (state.workspace === undefined) {
      throw workflowStateError(
        "Workflow input references missing workspace",
        "workflow_reference_missing"
      );
    }

    return state.workspace;
  }

  if (reference.startsWith("$.steps.")) {
    const stepId = reference.slice("$.steps.".length);

    if (stepId === "") {
      throw workflowStateError(
        `Unsupported workflow input reference: ${reference}`,
        "workflow_reference_unsupported"
      );
    }

    if (!Object.prototype.hasOwnProperty.call(state.steps, stepId)) {
      throw workflowStateError(
        `Workflow input references missing step output: ${stepId}`,
        "workflow_reference_missing"
      );
    }

    return state.steps[stepId];
  }

  throw workflowStateError(
    `Unsupported workflow input reference: ${reference}`,
    "workflow_reference_unsupported"
  );
}

export function resolveWorkflowInput(
  input: Record<string, unknown> | undefined,
  state: WorkflowState
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input ?? {})) {
    resolved[key] =
      typeof value === "string" && value.startsWith("$.")
        ? resolveReference(value, state)
        : value;
  }

  return resolved;
}
