import type { ObservedAgentEvent } from "../../core/agent-runtime/observed-agent-events.js";
import type { JsonObject } from "../../core/runtime/json.js";
import type { RunCompiledWorkflowInput } from "./workflow-runner-types.js";

type WorkflowEventInput = Pick<RunCompiledWorkflowInput, "backends" | "run">;

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
