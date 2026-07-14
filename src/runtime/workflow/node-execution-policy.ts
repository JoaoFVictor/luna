import type { BuiltInStepMetadata } from "../../core/built-ins/types.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import {
  selectReadyBatchWithPolicy,
  type ExecutionPolicyDecision
} from "../../core/workflow/execution-policy.js";
import {
  workflowExecutionPlanPolicyNode,
  type WorkflowExecutionPlanPolicyNode
} from "../../core/workflow/execution-plan.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";

export function executionPolicyDecisionForNode(
  input: RunWorkflowInput,
  node: CompiledWorkflowNode
): ExecutionPolicyDecision {
  return selectReadyBatchWithPolicy({
    ready: [workflowExecutionPlanPolicyNode(node)],
    maxConcurrency: 1,
    builtInMetadata: (candidate) => builtInMetadata(input, candidate)
  }).items[0].decision;
}

function builtInMetadata(
  input: RunWorkflowInput,
  node: WorkflowExecutionPlanPolicyNode
): BuiltInStepMetadata {
  return input.builtInMetadata?.(node.compiled) ?? {};
}
