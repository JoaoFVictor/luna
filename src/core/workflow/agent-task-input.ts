import { runtimeError } from "../runtime/errors.js";

export function requireWorkflowAgentTaskInput({
  input,
  nodeId,
  agentId,
  message
}: {
  readonly input: unknown;
  readonly nodeId: string;
  readonly agentId?: string;
  readonly message: string;
}): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  throw runtimeError(message, "runtime_state_invalid", {
    details: agentId === undefined ? { node_id: nodeId } : { node_id: nodeId, agent_id: agentId }
  });
}
