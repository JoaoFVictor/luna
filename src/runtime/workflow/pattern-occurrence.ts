import type { JsonValue } from "../../core/runtime/json.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type {
  RunWorkflowInput,
  WorkflowPatternOccurrenceExecutor
} from "../../core/workflow/execution-contracts.js";
import { patternStageOccurrenceNodeId } from "../../core/workflow/loop-identity.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import { runDurableNodeOccurrence } from "./node-occurrence.js";

const INTERNAL_PATTERN_STAGE_CAPABILITY = "luna.internal.pattern_stage";

export function createPatternOccurrenceExecutor({
  input,
  state,
  runtimeContext,
  patternNode
}: {
  readonly input: RunWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly patternNode: CompiledWorkflowNode;
}): WorkflowPatternOccurrenceExecutor {
  return async ({ attempt, stage_id: stageId, output_schema: outputSchema, execute }) => {
    // This journal proves what an already-authorized runtime invocation may
    // recover. It is not, by itself, control-plane replay authorization. If a
    // process is lost while an unsafe stage is active and Studio cannot prove
    // its output, Studio remains fail-closed (`outcome_unknown`) and never
    // re-enters the executor automatically.
    const occurrenceId = patternStageOccurrenceNodeId({
      pattern_node_id: patternNode.id,
      attempt,
      stage_id: stageId
    });
    const occurrenceNode = {
      id: occurrenceId,
      kind: "built_in",
      yaml_path: `${patternNode.yaml_path}.runtime_stages.${stageId}`,
      capability_id: INTERNAL_PATTERN_STAGE_CAPABILITY,
      output_schema: outputSchema,
      can_create_pending_interrupt: false,
      source: {
        id: occurrenceId,
        type: "built_in",
        uses: INTERNAL_PATTERN_STAGE_CAPABILITY,
        input: {}
      }
    } satisfies CompiledWorkflowNode;
    const occurrenceInput: RunWorkflowInput = {
      ...input,
      // The declaring pattern already owns the workflow lock. Reacquiring it
      // from a child occurrence can deadlock an exclusive write pattern.
      lockManager: undefined,
      builtIns: {
        ...input.builtIns,
        [INTERNAL_PATTERN_STAGE_CAPABILITY]: async () => await execute()
      }
    };
    const result = await runDurableNodeOccurrence({
      input: occurrenceInput,
      state,
      runtimeContext,
      node: occurrenceNode,
      projection: {
        state_node_id: occurrenceId,
        replace_existing_state: true,
        completion_failure: "recover"
      }
    });
    return result.output as JsonValue;
  };
}
