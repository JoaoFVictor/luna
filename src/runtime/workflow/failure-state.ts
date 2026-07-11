import { failNode } from "../../core/runtime/lifecycle.js";
import {
  validateCheckpointState,
  type LunaRuntimeState
} from "../../core/runtime/state.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import { mergeRuntimeReferences } from "./runtime-reference-codec.js";

export class WorkflowNodeAttemptFailure extends Error {
  readonly runtimeCause: unknown;
  readonly state: LunaRuntimeState;
  readonly code?: unknown;
  readonly details?: unknown;

  constructor(runtimeCause: unknown, state: LunaRuntimeState) {
    super(
      runtimeCause instanceof Error
        ? runtimeCause.message
        : "Workflow node attempt failed",
      { cause: runtimeCause }
    );
    this.name = runtimeCause instanceof Error
      ? runtimeCause.name
      : "WorkflowNodeAttemptFailure";
    if (runtimeCause instanceof Error && runtimeCause.stack !== undefined) {
      this.stack = runtimeCause.stack;
    }
    const metadata = runtimeCause as {
      readonly code?: unknown;
      readonly details?: unknown;
    } | null | undefined;
    if (metadata?.code !== undefined) {
      this.code = metadata.code;
    }
    if (metadata?.details !== undefined) {
      this.details = metadata.details;
    }
    this.runtimeCause = runtimeCause;
    this.state = state;
  }
}

export function nodeAttemptFailure(
  cause: unknown
): WorkflowNodeAttemptFailure | undefined {
  return cause instanceof WorkflowNodeAttemptFailure ? cause : undefined;
}

/**
 * Flattens LangGraph's possibly nested concurrent-task AggregateErrors and
 * returns node failures in a timing-independent order. The failed node id is
 * the primary key because every node attempt owns exactly one such identity.
 */
export function nodeAttemptFailures(
  cause: unknown
): WorkflowNodeAttemptFailure[] {
  const discovered: WorkflowNodeAttemptFailure[] = [];
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (
      (typeof candidate !== "object" || candidate === null) &&
      typeof candidate !== "function"
    ) {
      return;
    }
    if (seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    if (candidate instanceof WorkflowNodeAttemptFailure) {
      discovered.push(candidate);
    }
    if (candidate instanceof AggregateError) {
      for (const nested of candidate.errors) {
        visit(nested);
      }
    }
    if (candidate instanceof Error && candidate.cause !== undefined) {
      visit(candidate.cause);
    }
  };
  visit(cause);

  return discovered.sort((left, right) => {
    const leftKey = nodeAttemptFailureSortKey(left);
    const rightKey = nodeAttemptFailureSortKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function nodeAttemptFailureSortKey(failure: WorkflowNodeAttemptFailure): string {
  const nodeId = failure.state.primary_failure?.node_id ?? "\uffff";
  const runtimeCause = failure.runtimeCause;
  const causeKey = runtimeCause instanceof Error
    ? `${runtimeCause.name}\u0000${runtimeCause.message}`
    : typeof runtimeCause;
  return `${nodeId}\u0000${causeKey}`;
}

export function failWorkflowNodeAttempt(
  cause: unknown,
  state: LunaRuntimeState,
  nodeId: string
): WorkflowNodeAttemptFailure {
  return new WorkflowNodeAttemptFailure(cause, failNode(state, nodeId));
}

export function runtimeStateFromCheckpoint(
  value: unknown
): LunaRuntimeState | undefined {
  try {
    validateCheckpointState(value);
    return value as LunaRuntimeState;
  } catch {
    return undefined;
  }
}

function sameRun(
  left: LunaRuntimeState,
  right: LunaRuntimeState
): boolean {
  return (
    left.run.run_id === right.run.run_id &&
    left.run.workflow_id === right.run.workflow_id &&
    left.run.attempt === right.run.attempt &&
    left.run.started_at === right.run.started_at &&
    left.workflow.id === right.workflow.id &&
    left.workflow.mode === right.workflow.mode
  );
}

/**
 * Merges a durable scheduler checkpoint with the exact failed-node state.
 * The failed node status and attempt win; independent completed branches from
 * the checkpoint are retained according to the runtime channel reducers.
 */
export function mergeNodeFailureWithCheckpoint(
  failureState: LunaRuntimeState,
  checkpointValue: unknown
): LunaRuntimeState {
  const checkpointState = runtimeStateFromCheckpoint(checkpointValue);
  if (checkpointState === undefined) {
    return { ...failureState, run_status: "failed" };
  }

  return mergeNodeFailureWithRuntimeState(failureState, checkpointState);
}

/**
 * Retains completed branches from an in-memory full runtime state while the
 * exact failed-node lifecycle from failureState remains authoritative.
 */
export function mergeNodeFailureWithRuntimeState(
  failureState: LunaRuntimeState,
  runtimeState: LunaRuntimeState
): LunaRuntimeState {
  if (!sameRun(failureState, runtimeState)) {
    return { ...failureState, run_status: "failed" };
  }

  const merged: LunaRuntimeState = {
    ...failureState,
    run_status: "failed",
    node_statuses: {
      ...runtimeState.node_statuses,
      ...failureState.node_statuses
    },
    steps: {
      ...failureState.steps,
      ...runtimeState.steps
    },
    attempts: {
      ...runtimeState.attempts,
      ...failureState.attempts
    },
    artifact_refs: mergeRuntimeReferences(
      failureState.artifact_refs,
      runtimeState.artifact_refs
    ),
    interrupt_refs: mergeRuntimeReferences(
      failureState.interrupt_refs,
      runtimeState.interrupt_refs
    ),
    ...(runtimeState.event_cursor === undefined
      ? {}
      : { event_cursor: runtimeState.event_cursor }),
    ...(failureState.primary_failure === undefined
      ? {}
      : { primary_failure: failureState.primary_failure })
  };
  validateCheckpointState(merged);
  return merged;
}

/**
 * Merges every failed task from one concurrent scheduler batch. The first
 * stably ordered failure remains the primary cause/state authority, while all
 * secondary failed lifecycles and already-reduced completed siblings survive.
 */
export function mergeNodeFailuresWithRuntimeState(
  failures: readonly WorkflowNodeAttemptFailure[],
  runtimeState: LunaRuntimeState
): LunaRuntimeState {
  if (failures.length === 0) {
    return runtimeState;
  }

  let merged = runtimeState;
  for (const failure of failures.slice(1)) {
    merged = mergeNodeFailureWithRuntimeState(failure.state, merged);
  }
  return mergeNodeFailureWithRuntimeState(failures[0].state, merged);
}

export function observeFailedState(
  input: Pick<RunWorkflowInput, "onFailedState">,
  state: LunaRuntimeState
): void {
  try {
    input.onFailedState?.(state);
  } catch {
    // Observation cannot replace or suppress the authoritative runtime error.
  }
}
