import {
  runtimeDurabilityRecoveryRequiredFrom,
  runtimeError
} from "../../core/runtime/errors.js";
import { startNodeAttempt } from "../../core/runtime/lifecycle.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import { appendWorkflowNodeLifecycleEvent } from "../../core/workflow/events.js";
import { failWorkflowNodeAttempt } from "./failure-state.js";

export type ActiveWorkflowNodeAttempt = {
  readonly state: LunaRuntimeState;
  readonly attempt: number;
};

export function beginWorkflowNodeAttempt(
  state: LunaRuntimeState,
  node: CompiledWorkflowNode
): ActiveWorkflowNodeAttempt {
  const started = startNodeAttempt(state, node.id, 1);
  const attempt = started.attempts[node.id]?.count;
  if (attempt === undefined) {
    throw runtimeError(
      "Started node attempt is missing its lifecycle counter",
      "runtime_state_invalid",
      { details: { node_id: node.id } }
    );
  }
  return { state: started, attempt };
}

export async function observeWorkflowNodeStarted({
  input,
  node,
  active,
  outputAlreadyDurable = false
}: {
  readonly input: RunWorkflowInput;
  readonly node: CompiledWorkflowNode;
  readonly active: ActiveWorkflowNodeAttempt;
  readonly outputAlreadyDurable?: boolean;
}): Promise<void> {
  const observation = appendWorkflowNodeLifecycleEvent(input, {
    type: "node.started",
    node_id: node.id,
    attempt: active.attempt,
    occurred_at: active.state.node_statuses[node.id]?.started_at ??
      new Date().toISOString(),
    artifact_count: active.state.artifact_refs.length,
    interrupt_count: active.state.interrupt_refs.length
  });
  if (outputAlreadyDurable) {
    await observation.catch(() => {
      // A prior executor output is authoritative. Diagnostics cannot block
      // the deterministic completion recovery that follows.
    });
    return;
  }
  await observation;
}

export async function observeWorkflowNodeSucceeded({
  input,
  node,
  active,
  succeeded
}: {
  readonly input: RunWorkflowInput;
  readonly node: CompiledWorkflowNode;
  readonly active: ActiveWorkflowNodeAttempt;
  readonly succeeded: LunaRuntimeState;
}): Promise<void> {
  await appendWorkflowNodeLifecycleEvent(input, {
    type: "node.succeeded",
    node_id: node.id,
    attempt: active.attempt,
    occurred_at: succeeded.node_statuses[node.id]?.completed_at ??
      new Date().toISOString(),
    artifact_count: succeeded.artifact_refs.length,
    interrupt_count: succeeded.interrupt_refs.length
  }).catch(() => {
    // The completion marker is authoritative; telemetry is best-effort.
  });
}

export async function failObservedWorkflowNodeAttempt({
  input,
  node,
  active,
  state,
  cause
}: {
  readonly input: RunWorkflowInput;
  readonly node: CompiledWorkflowNode;
  readonly active: ActiveWorkflowNodeAttempt;
  readonly state: LunaRuntimeState;
  readonly cause: unknown;
}): Promise<never> {
  const durabilityFailure = runtimeDurabilityRecoveryRequiredFrom(cause);
  if (durabilityFailure !== undefined) {
    // A durable output or completion marker may already exist. Exact
    // checkpoint readback is the only safe retry classifier.
    throw durabilityFailure;
  }
  await appendWorkflowNodeLifecycleEvent(input, {
    type: "node.failed",
    node_id: node.id,
    attempt: active.attempt,
    occurred_at: new Date().toISOString(),
    artifact_count: state.artifact_refs.length,
    interrupt_count: state.interrupt_refs.length
  }).catch(() => {
    // Preserve the authoritative runtime failure over diagnostics.
  });
  throw failWorkflowNodeAttempt(cause, state, node.id);
}
