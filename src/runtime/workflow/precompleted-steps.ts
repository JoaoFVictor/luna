import { runtimeError } from "../../core/runtime/errors.js";
import {
  assertCheckpointJsonObject,
  stableJson,
  type JsonValue
} from "../../core/runtime/json.js";
import type { CompiledWorkflow } from "../../core/workflow/compiler.js";
import type { WorkflowPrecompletedSteps } from "../../core/workflow/execution-contracts.js";
import { assertNodeOutputMatchesSchema } from "./node-output-validation.js";

export function validatePrecompletedSteps(
  compiled: CompiledWorkflow,
  value: WorkflowPrecompletedSteps | undefined
): WorkflowPrecompletedSteps {
  if (value === undefined) return {};
  assertCheckpointJsonObject(value, "$.precompleted_steps");

  const nodes = new Map(compiled.nodes.map((node) => [node.id, node]));
  for (const [nodeId, output] of Object.entries(value)) {
    const node = nodes.get(nodeId);
    if (node === undefined) {
      throw runtimeError(
        "Precompleted steps reference an unknown workflow node",
        "runtime_state_invalid",
        { details: { node_id: nodeId } }
      );
    }
    assertNodeOutputMatchesSchema(node, output);
  }

  return Object.fromEntries(Object.entries(value));
}

/**
 * Drops source-valid cutpoints pruned by the canonical effective DAG.
 * Callers must validate ids against the scoped source workflow first.
 */
export function selectEffectivePrecompletedSteps(
  compiled: CompiledWorkflow,
  value: WorkflowPrecompletedSteps | undefined
): WorkflowPrecompletedSteps | undefined {
  if (value === undefined) return undefined;
  const effectiveNodeIds = new Set(compiled.nodes.map((node) => node.id));
  return Object.fromEntries(
    Object.entries(value).filter(([nodeId]) => effectiveNodeIds.has(nodeId))
  );
}

export function mergePrecompletedStepsWithRecovery(
  precompleted: WorkflowPrecompletedSteps,
  recovered: Readonly<Record<string, JsonValue>>
): Record<string, JsonValue> {
  for (const [nodeId, output] of Object.entries(precompleted)) {
    if (
      Object.prototype.hasOwnProperty.call(recovered, nodeId) &&
      stableJson(recovered[nodeId]) !== stableJson(output)
    ) {
      throw runtimeError(
        "Precompleted step conflicts with its recovered node output",
        "runtime_checkpoint_schema_mismatch",
        { details: { node_id: nodeId } }
      );
    }
  }
  return { ...precompleted, ...recovered };
}
