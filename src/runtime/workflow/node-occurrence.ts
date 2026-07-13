import type { JsonValue } from "../../core/runtime/json.js";
import type {
  LunaRuntimeState,
  RuntimeArtifactRef
} from "../../core/runtime/state.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import { runtimeError } from "../../core/runtime/errors.js";
import { executionPolicyDecisionForNode } from "./node-execution-policy.js";
import {
  recoverPersistedWorkflowNodeAttempt,
  runWorkflowNodeAttempt
} from "./node-runner.js";
import { loadPersistedNodeDurability } from "./persisted-node-recovery.js";
import type { WorkflowNodeExecutionProjection } from "./node-output-finalizer.js";
import { assertNodeOutputMatchesSchema } from "./node-output-validation.js";

export type DurableNodeOccurrenceResult = {
  readonly output: JsonValue;
  readonly artifact_refs: RuntimeArtifactRef[];
  readonly recovered: boolean;
};

/**
 * Executes one runtime-owned occurrence through the canonical node protocol.
 *
 * Occurrences are not top-level compiled graph nodes, but their output and
 * completion writes, pre-execution barrier, lifecycle events, and recovery
 * semantics are deliberately identical to those of a normal node.
 */
export async function runDurableNodeOccurrence({
  input,
  state,
  runtimeContext,
  node,
  projection
}: {
  readonly input: RunWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
  readonly projection: WorkflowNodeExecutionProjection;
}): Promise<DurableNodeOccurrenceResult> {
  const durability = await loadPersistedNodeDurability(
    input,
    input.run.run_id,
    node
  );
  if (durability.kind === "completed") {
    assertNodeOutputMatchesSchema(node, durability.output);
    return {
      output: durability.output,
      artifact_refs: [...durability.artifactRefs],
      recovered: true
    };
  }

  const attempt = durability.kind === "output_pending"
    ? await recoverPersistedWorkflowNodeAttempt({
        input,
        state,
        runtimeContext,
        node,
        decision: executionPolicyDecisionForNode(input, node),
        output: durability.output,
        binaryAssets: durability.binaryAssets,
        projection
      })
    : await runWorkflowNodeAttempt({
        input,
        state,
        runtimeContext,
        node,
        decision: executionPolicyDecisionForNode(input, node),
        projection
      });
  if (attempt.kind !== "completed") {
    throw runtimeError(
      "Durable node occurrence created an unexpected interrupt",
      "runtime_state_invalid",
      { details: { node_id: node.id } }
    );
  }
  const output = attempt.update.steps[projection.state_node_id];
  if (output === undefined) {
    throw runtimeError(
      "Durable node occurrence completed without projected output",
      "runtime_state_invalid",
      { details: { node_id: node.id } }
    );
  }
  return {
    output,
    artifact_refs: attempt.update.artifact_refs ?? [],
    recovered: durability.kind === "output_pending"
  };
}
