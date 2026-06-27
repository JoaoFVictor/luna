import type { ObservedAgentEvent } from "../agent-runtime/observed-agent-events.js";
import type { RuntimeEventStore } from "../runtime/events/contracts.js";
import type { JsonObject } from "../runtime/json.js";
import type { RunHandle } from "../runtime/run-handle.js";

export type WorkflowEventInput = {
  readonly backends: {
    readonly events: RuntimeEventStore;
  };
  readonly run: RunHandle;
};

export async function appendWorkflowEvent(
  input: WorkflowEventInput,
  type: string,
  nodeId?: string,
  interruptIdValue?: string,
  data?: JsonObject
): Promise<void> {
  await input.backends.events.append({
    id: `${input.run.run_id}:${type}:${nodeId ?? "run"}:${Date.now()}`,
    run_id: input.run.run_id,
    type,
    timestamp: new Date().toISOString(),
    ...(nodeId === undefined ? {} : { node_id: nodeId }),
    ...(interruptIdValue === undefined ? {} : { interrupt_id: interruptIdValue }),
    ...(data === undefined ? {} : { data })
  });
}

export function workflowAgentEventEmitter(
  input: WorkflowEventInput
): (event: ObservedAgentEvent) => Promise<void> {
  return async (event) => {
    await appendWorkflowEvent(input, event.type, event.nodeId, undefined, event.data);
  };
}
