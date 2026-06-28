import type { ObservedAgentEvent } from "../agent-runtime/observed-agent-events.js";
import type { WorkflowObservability } from "../observability/workflow-observability.js";
import type { JsonObject } from "../runtime/json.js";

export type WorkflowEventInput = {
  readonly observability?: WorkflowObservability;
};

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

export function workflowAgentEventEmitter(
  input: WorkflowEventInput
): (event: ObservedAgentEvent) => Promise<void> {
  return async (event) => {
    await appendWorkflowEvent(input, event.type, event.nodeId, undefined, event.data);
  };
}
