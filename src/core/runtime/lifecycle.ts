import { runtimeError } from "./errors.js";
import {
  validateCheckpointState,
  type LunaNodeStatus,
  type LunaRuntimeState,
  type RuntimeAttemptRecord,
  type RuntimeNodeStatus,
  type RuntimePrimaryFailure
} from "./state.js";

type TerminalAttemptStatus = Exclude<RuntimeAttemptRecord["status"], "started">;

export type StartNodeAttemptOptions = {
  retryPermitted?: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function cloneState(state: LunaRuntimeState): LunaRuntimeState {
  return {
    ...state,
    node_statuses: { ...state.node_statuses },
    steps: { ...state.steps },
    attempts: Object.fromEntries(
      Object.entries(state.attempts).map(([nodeId, attempts]) => [
        nodeId,
        {
          count: attempts.count,
          history: attempts.history.map((record) => ({ ...record }))
        }
      ])
    ),
    artifact_refs: [...state.artifact_refs],
    interrupt_refs: [...state.interrupt_refs],
    ...(state.primary_failure === undefined
      ? {}
      : { primary_failure: { ...state.primary_failure } })
  };
}

function nodeStatus(state: LunaRuntimeState, nodeId: string): RuntimeNodeStatus {
  return state.node_statuses[nodeId] ?? { status: "pending" };
}

function attemptHistory(
  state: LunaRuntimeState,
  nodeId: string
): RuntimeAttemptRecord[] {
  return state.attempts[nodeId]?.history ?? [];
}

function latestAttempt(
  state: LunaRuntimeState,
  nodeId: string
): RuntimeAttemptRecord | undefined {
  return attemptHistory(state, nodeId).at(-1);
}

function lifecycleError(
  message: string,
  code:
    | "runtime_node_attempt_invalid"
    | "runtime_node_status_transition_invalid"
    | "runtime_retry_not_permitted",
  details: Record<string, unknown>
): never {
  throw runtimeError(message, code, { details });
}

function assertPositiveAttempt(attempt: number, nodeId: string): void {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    lifecycleError(
      `Node ${nodeId} attempt must be a positive integer`,
      "runtime_node_attempt_invalid",
      { node_id: nodeId, attempt }
    );
  }
}

function withValidatedState(state: LunaRuntimeState): LunaRuntimeState {
  validateCheckpointState(state);
  return state;
}

function setPrimaryFailure(
  state: LunaRuntimeState,
  failure: RuntimePrimaryFailure
): void {
  state.primary_failure ??= failure;
}

function updateLatestAttempt(
  state: LunaRuntimeState,
  nodeId: string,
  status: TerminalAttemptStatus,
  errorRef?: string
): void {
  const attempts = state.attempts[nodeId];
  const latest = attempts?.history.at(-1);

  if (
    attempts === undefined ||
    latest === undefined ||
    latest.status !== "started"
  ) {
    lifecycleError(
      `Node ${nodeId} has no active attempt to complete`,
      "runtime_node_status_transition_invalid",
      { node_id: nodeId }
    );
  }

  attempts.history = [
    ...attempts.history.slice(0, -1),
    {
      ...latest,
      status,
      completed_at: nowIso(),
      ...(errorRef === undefined ? {} : { error_ref: errorRef })
    }
  ];
}

function completeNode(
  state: LunaRuntimeState,
  nodeId: string,
  status: LunaNodeStatus,
  attemptStatus: TerminalAttemptStatus,
  errorRef?: string
): LunaRuntimeState {
  const current = nodeStatus(state, nodeId);
  if (current.status !== "running") {
    lifecycleError(
      `Node ${nodeId} cannot transition from ${current.status} to ${status}`,
      "runtime_node_status_transition_invalid",
      { node_id: nodeId, status: current.status, target_status: status }
    );
  }

  const next = cloneState(state);
  updateLatestAttempt(next, nodeId, attemptStatus, errorRef);
  next.node_statuses[nodeId] = {
    ...current,
    status,
    completed_at: nowIso(),
    ...(errorRef === undefined ? {} : { error_ref: errorRef })
  };

  if (status === "failed" || status === "timed_out") {
    setPrimaryFailure(next, {
      node_id: nodeId,
      status,
      ...(errorRef === undefined ? {} : { error_ref: errorRef })
    });
  }

  return withValidatedState(next);
}

export function startNodeAttempt(
  state: LunaRuntimeState,
  nodeId: string,
  attempt: number,
  options: StartNodeAttemptOptions = {}
): LunaRuntimeState {
  assertPositiveAttempt(attempt, nodeId);

  const current = nodeStatus(state, nodeId);
  const currentHistory = attemptHistory(state, nodeId);
  const last = currentHistory.at(-1);
  const isFirstAttempt = current.status === "pending" && attempt === 1;
  const isRetryAttempt =
    state.run_status === "waiting_for_retry" &&
    last !== undefined &&
    last.attempt + 1 === attempt &&
    (last.status === "failed" || last.status === "timed_out");

  if (isRetryAttempt && options.retryPermitted !== true) {
    lifecycleError(
      `Node ${nodeId} retry attempt ${attempt} is not permitted`,
      "runtime_retry_not_permitted",
      { node_id: nodeId, attempt }
    );
  }

  if (!isFirstAttempt && !isRetryAttempt) {
    lifecycleError(
      `Node ${nodeId} cannot start attempt ${attempt} from ${current.status}`,
      "runtime_node_attempt_invalid",
      {
        node_id: nodeId,
        status: current.status,
        attempt,
        current_attempt: last?.attempt ?? 0
      }
    );
  }

  const next = cloneState(state);
  const startedAt = nowIso();
  next.run_status = "running";
  next.node_statuses[nodeId] = {
    status: "running",
    attempt,
    started_at: startedAt
  };
  next.attempts[nodeId] = {
    count: attempt,
    history: [
      ...currentHistory,
      {
        attempt,
        status: "started",
        started_at: startedAt
      }
    ]
  };

  return withValidatedState(next);
}

export function succeedNode(
  state: LunaRuntimeState,
  nodeId: string
): LunaRuntimeState {
  return completeNode(state, nodeId, "succeeded", "succeeded");
}

export function failNode(
  state: LunaRuntimeState,
  nodeId: string,
  errorRef?: string
): LunaRuntimeState {
  return completeNode(state, nodeId, "failed", "failed", errorRef);
}

export function timeOutNode(
  state: LunaRuntimeState,
  nodeId: string,
  errorRef?: string
): LunaRuntimeState {
  return completeNode(state, nodeId, "timed_out", "timed_out", errorRef);
}

export function cancelNode(
  state: LunaRuntimeState,
  nodeId: string
): LunaRuntimeState {
  const current = nodeStatus(state, nodeId);
  if (current.status === "running") {
    const next = completeNode(state, nodeId, "cancelled", "cancelled");
    return withValidatedState({
      ...next,
      run_status: "cancelled"
    });
  }

  if (current.status !== "waiting_for_input") {
    lifecycleError(
      `Node ${nodeId} cannot be cancelled from ${current.status}`,
      "runtime_node_status_transition_invalid",
      { node_id: nodeId, status: current.status }
    );
  }

  const next = cloneState(state);
  updateLatestAttempt(next, nodeId, "cancelled");
  next.run_status = "cancelled";
  next.node_statuses[nodeId] = {
    ...current,
    status: "cancelled",
    completed_at: nowIso()
  };
  return withValidatedState(next);
}

export function waitForRetry(
  state: LunaRuntimeState,
  nodeId: string
): LunaRuntimeState {
  const current = nodeStatus(state, nodeId);
  const latest = latestAttempt(state, nodeId);

  if (
    (current.status !== "failed" && current.status !== "timed_out") ||
    latest === undefined ||
    latest.status === "started"
  ) {
    lifecycleError(
      `Node ${nodeId} cannot wait for retry from ${current.status}`,
      "runtime_node_status_transition_invalid",
      { node_id: nodeId, status: current.status }
    );
  }

  return withValidatedState({
    ...cloneState(state),
    run_status: "waiting_for_retry"
  });
}

export function markNodeWaitingForInput(
  state: LunaRuntimeState,
  nodeId: string
): LunaRuntimeState {
  const current = nodeStatus(state, nodeId);
  if (current.status !== "running") {
    lifecycleError(
      `Node ${nodeId} cannot wait for input from ${current.status}`,
      "runtime_node_status_transition_invalid",
      { node_id: nodeId, status: current.status }
    );
  }

  const next = cloneState(state);
  next.run_status = "waiting_for_input";
  next.node_statuses[nodeId] = {
    ...current,
    status: "waiting_for_input"
  };

  return withValidatedState(next);
}

export function markDependencyFailedSkip(
  state: LunaRuntimeState,
  nodeId: string
): LunaRuntimeState {
  const current = nodeStatus(state, nodeId);
  if (current.status !== "pending") {
    lifecycleError(
      `Node ${nodeId} cannot be dependency-skipped from ${current.status}`,
      "runtime_node_status_transition_invalid",
      { node_id: nodeId, status: current.status }
    );
  }

  const next = cloneState(state);
  next.node_statuses[nodeId] = {
    status: "skipped_dependency_failed",
    completed_at: nowIso()
  };

  return withValidatedState(next);
}
