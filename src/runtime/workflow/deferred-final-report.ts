import type { BuiltInStepMetadata } from "../../core/built-ins/types.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import {
  splitDeferredFinalReportNodesByPolicy
} from "../../core/workflow/execution-policy.js";
import {
  workflowExecutionPlanPolicyNode,
  type WorkflowExecutionPlanPolicyNode
} from "../../core/workflow/execution-plan.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";

export function deferredFinalReportNodeIds(
  input: RunWorkflowInput,
  nodes: readonly CompiledWorkflowNode[]
): ReadonlySet<string> {
  const { deferredNodes } = splitDeferredFinalReportNodesByPolicy({
    nodes: nodes.map(workflowExecutionPlanPolicyNode),
    builtInMetadata: (node) => builtInMetadataForPolicyNode(input, node)
  });

  return new Set(deferredNodes.map((node) => node.id));
}

function builtInMetadataForPolicyNode(
  input: RunWorkflowInput,
  node: WorkflowExecutionPlanPolicyNode
): BuiltInStepMetadata {
  return input.builtInMetadata?.(node.compiled) ?? {};
}
