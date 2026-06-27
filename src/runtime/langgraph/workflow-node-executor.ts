import { runtimeError } from "../../core/runtime/errors.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import { resolveNodeInput } from "../../core/workflow/runner-input.js";
import type { WorkflowDefinition } from "../../core/workflow/definition-types.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import { executeAgentNode } from "./workflow-agent-bridge.js";
import type {
  RunCompiledWorkflowInput,
  WorkflowPatternExecutor
} from "./workflow-runner-types.js";

export async function executeNode(
  input: RunCompiledWorkflowInput,
  state: LunaRuntimeState,
  runtimeContext: WorkflowRuntimeContext,
  node: CompiledWorkflowNode
): Promise<unknown> {
  if (node.kind === "built_in" || node.kind === "pattern") {
    const nodeInput = await resolveNodeInput(node, state, runtimeContext, input);
    if (node.kind === "pattern") {
      return await executePatternNode({
        workflowInput: input,
        executor: input.patternExecutors?.[node.capability_id],
        node,
        input: nodeInput,
        state,
        runtimeContext,
        workflow: input.workflow,
        observabilitySummary: input.observabilitySummary
      });
    }

    const executor = input.builtIns[node.capability_id];
    if (executor === undefined) {
      throw runtimeError("No executor registered for workflow node", "runtime_state_invalid", {
        details: { node_id: node.id, capability_id: node.capability_id }
      });
    }

    return await executor({
      node,
      input: nodeInput,
      state,
      runtimeContext,
      workflow: input.workflow,
      observabilitySummary: input.observabilitySummary
    });
  }

  if (node.kind === "agent") {
    return await executeAgentNode({ input, state, runtimeContext, node });
  }

  throw runtimeError("Unsupported compiled node kind", "runtime_state_invalid", {
    details: { node_id: node.id, kind: node.kind }
  });
}

async function executePatternNode({
  executor,
  workflowInput,
  node,
  input,
  state,
  runtimeContext,
  workflow,
  observabilitySummary
}: {
  readonly executor: WorkflowPatternExecutor | undefined;
  readonly workflowInput: RunCompiledWorkflowInput;
  readonly node: CompiledWorkflowNode;
  readonly input: unknown;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly workflow: WorkflowDefinition;
  readonly observabilitySummary?: RunCompiledWorkflowInput["observabilitySummary"];
}): Promise<unknown> {
  if (executor === undefined) {
    throw runtimeError("No executor registered for workflow pattern node", "runtime_state_invalid", {
      details: { node_id: node.id, capability_id: node.capability_id }
    });
  }

  return await executor({
    workflowInput,
    node,
    input,
    state,
    runtimeContext,
    workflow,
    observabilitySummary
  });
}
