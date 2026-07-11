import type { ObservedAgentEvent } from "../agent-runtime/observed-agent-events.js";
import type { WorkflowObservability } from "../observability/workflow-observability.js";
import type { JsonObject } from "../runtime/json.js";

export type WorkflowEventInput = {
  readonly observability?: WorkflowObservability;
  readonly onLifecycleEvent?: WorkflowNodeLifecycleObserver;
  readonly onLifecycleProjectionError?: WorkflowLifecycleProjectionErrorObserver;
};

export type WorkflowNodeLifecycleEvent = {
  readonly type: "node.started" | "node.succeeded" | "node.failed";
  readonly node_id: string;
  readonly attempt: number;
  readonly occurred_at: string;
  readonly artifact_count: number;
  readonly interrupt_count: number;
};

export type WorkflowNodeLifecycleObserver = (
  event: WorkflowNodeLifecycleEvent
) => Promise<void>;

export type WorkflowLifecycleProjectionErrorObserver = (
  cause: unknown,
  event: WorkflowNodeLifecycleEvent
) => void;

export async function appendWorkflowEvent(
  input: WorkflowEventInput,
  type: string,
  nodeId?: string,
  interruptIdValue?: string,
  data?: JsonObject
): Promise<void> {
  await input.observability?.recorder.addEvent(type, {
    ...(nodeId === undefined ? {} : { node_id: nodeId }),
    ...(interruptIdValue === undefined ? {} : { interrupt_id: interruptIdValue }),
    ...(data === undefined ? {} : data)
  });
}

export async function appendWorkflowNodeLifecycleEvent(
  input: WorkflowEventInput,
  event: WorkflowNodeLifecycleEvent
): Promise<void> {
  const projection = Promise.resolve()
    .then(async () => await input.onLifecycleEvent?.(event))
    .catch((cause) => {
      try {
        input.onLifecycleProjectionError?.(cause, event);
      } catch {
        // Observation must never change workflow outcome or retry semantics.
      }
    });
  await Promise.all([
    appendWorkflowEvent(input, event.type, event.node_id, undefined, {
      attempt: event.attempt,
      occurred_at: event.occurred_at,
      artifact_count: event.artifact_count,
      interrupt_count: event.interrupt_count
    }),
    projection
  ]);
}

export function workflowAgentEventEmitter(
  input: WorkflowEventInput
): (event: ObservedAgentEvent) => Promise<void> {
  return async (event) => {
    await appendWorkflowEvent(input, event.type, event.nodeId, undefined, event.data);
  };
}
