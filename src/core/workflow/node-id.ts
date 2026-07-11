import { LUNA_RUNTIME_STATE_FIELD_NAMES } from "../runtime/state.js";

const LUNA_INTERNAL_WORKFLOW_NODE_ID_PREFIX = "__luna_";
const LANGGRAPH_RESERVED_NODE_IDS = new Set<string>([
  "__start__",
  "__end__",
  ...LUNA_RUNTIME_STATE_FIELD_NAMES
]);
const LANGGRAPH_RESERVED_NODE_ID_CHARACTERS = [":", "|"] as const;

/**
 * Keeps public node ids disjoint from Luna's durable protocol records and
 * LangGraph's node/channel namespace.
 */
export function isReservedWorkflowNodeId(nodeId: string): boolean {
  return (
    nodeId.startsWith(LUNA_INTERNAL_WORKFLOW_NODE_ID_PREFIX) ||
    LANGGRAPH_RESERVED_NODE_IDS.has(nodeId) ||
    LANGGRAPH_RESERVED_NODE_ID_CHARACTERS.some((character) =>
      nodeId.includes(character)
    )
  );
}
