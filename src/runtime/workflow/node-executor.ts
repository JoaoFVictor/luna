import { runtimeError } from "../../core/runtime/errors.js";
import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import type { JsonSchemaLike } from "../../core/capabilities/json-schema-types.js";
import { assertCheckpointJsonValue } from "../../core/runtime/json.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import { resolveNodeInput } from "../../core/workflow/runner-input.js";
import type { WorkflowDefinition } from "../../core/workflow/definition-types.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import { executeAgentNode } from "./agent-node-executor.js";
import type {
  RunWorkflowInput,
  WorkflowPatternExecutor
} from "../../core/workflow/execution-contracts.js";
import { createPatternOccurrenceExecutor } from "./pattern-occurrence.js";

export async function executeWorkflowNode(
  input: RunWorkflowInput,
  state: LunaRuntimeState,
  runtimeContext: WorkflowRuntimeContext,
  node: CompiledWorkflowNode
): Promise<unknown> {
  if (node.kind === "workflow") {
    const nodeInput = await resolveNodeInput(node, state, runtimeContext, input);
    assertCheckpointJsonValue(nodeInput);
    const child = node.composition;
    if (!matchesJsonSchema(
      child.workflow.input_schema_content as JsonSchemaLike,
      nodeInput
    )) {
      throw runtimeError("Composed workflow input failed schema validation", "runtime_node_output_schema_invalid", {
        details: { node_id: node.id, workflow_id: child.workflow.id }
      });
    }
    if (input.compositionExecutor === undefined) {
      throw runtimeError("No executor registered for composed workflow node", "runtime_state_invalid", {
        details: { node_id: node.id, workflow_id: child.workflow.id }
      });
    }
    return await input.compositionExecutor({
      workflowInput: input,
      node,
      input: nodeInput,
      child
    });
  }
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
        workflow: input.workflow
      });
    }

    const executor = input.builtIns[node.capability_id];
    if (executor === undefined) {
      throw runtimeError("No executor registered for workflow node", "runtime_state_invalid", {
        details: { node_id: node.id, capability_id: node.capability_id }
      });
    }

    const runBuiltIn = async () =>
      await executor({
        node,
        input: nodeInput,
        state,
        runtimeContext,
        workflow: input.workflow,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        observability: input.observability
      });

    if (input.observability !== undefined) {
      return await input.observability.recorder.withSpan(
        {
          name: `built_in.${node.capability_id}`,
          kind: "built_in",
          nodeId: node.id,
          capabilityId: node.capability_id,
          attributes: {
            "luna.node.kind": node.kind
          }
        },
        runBuiltIn
      );
    }

    return await runBuiltIn();
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
  workflow
}: {
  readonly executor: WorkflowPatternExecutor | undefined;
  readonly workflowInput: RunWorkflowInput;
  readonly node: CompiledWorkflowNode;
  readonly input: unknown;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly workflow: WorkflowDefinition;
}): Promise<unknown> {
  if (executor === undefined) {
    throw runtimeError("No executor registered for workflow pattern node", "runtime_state_invalid", {
      details: { node_id: node.id, capability_id: node.capability_id }
    });
  }

  const runPattern = async () => await executor({
    workflowInput,
    node,
    input,
    state,
    runtimeContext,
    workflow,
    runOccurrence: createPatternOccurrenceExecutor({
      input: workflowInput,
      state,
      runtimeContext,
      patternNode: node
    }),
    observability: workflowInput.observability
  });

  if (workflowInput.observability !== undefined) {
    return await workflowInput.observability.recorder.withSpan(
      {
        name: `pattern.${node.capability_id}`,
        kind: "gate",
        nodeId: node.id,
        capabilityId: node.capability_id,
        attributes: {
          "luna.node.kind": node.kind
        }
      },
      runPattern
    );
  }

  return await runPattern();
}
