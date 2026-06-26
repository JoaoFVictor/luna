import type { JsonValue } from "../runtime/json.js";
import type { LunaRuntimeState } from "../runtime/state.js";
import type { CompiledWorkflow } from "./compiler.js";
import { terminalWorkflowNodes } from "./runner-graph.js";

export function finalWorkflowOutput(
  compiled: CompiledWorkflow,
  state: LunaRuntimeState,
  deferredFinalReportIds: ReadonlySet<string> = new Set()
): JsonValue {
  const terminalNodes = terminalWorkflowNodes(compiled);
  const outputNodes =
    deferredFinalReportIds.size === 0
      ? terminalNodes
      : terminalNodes.filter((node) => deferredFinalReportIds.has(node.id));

  if (outputNodes.length === 0) {
    return {};
  }
  if (outputNodes.length === 1) {
    return state.steps[outputNodes[0].id] ?? {};
  }

  return Object.fromEntries(
    outputNodes.map((node) => [node.id, state.steps[node.id] ?? {}])
  );
}
