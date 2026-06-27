import { END, START } from "@langchain/langgraph";
import type { BuiltInStepMetadata } from "../../core/built-ins/types.js";
import {
  workflowExecutionPlanEdges,
  workflowExecutionPlanPolicyNode,
  type WorkflowExecutionPlanEdge,
  type WorkflowExecutionPlanPolicyNode
} from "../../core/workflow/execution-plan.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { RunCompiledWorkflowInput } from "./workflow-runner-types.js";

export type LangGraphEdge = WorkflowExecutionPlanEdge;

export function groupLangGraphEdges(
  edges: readonly LangGraphEdge[]
): { readonly from: string | string[]; readonly to: string }[] {
  const byTarget = new Map<string, string[]>();
  const terminalEdges: { readonly from: string; readonly to: string }[] = [];

  for (const edge of edges) {
    const from = edge.from === "__start__" ? START : edge.from;
    const to = edge.to === "__end__" ? END : edge.to;
    if (to === END) {
      terminalEdges.push({ from, to });
      continue;
    }

    const existing = byTarget.get(to);
    if (existing === undefined) {
      byTarget.set(to, [from]);
      continue;
    }

    existing.push(from);
  }

  return [
    ...[...byTarget.entries()].map(([to, from]) => ({
      to,
      from: from.length === 1 ? from[0] : from
    })),
    ...terminalEdges
  ];
}

export function langGraphEdges(
  input: RunCompiledWorkflowInput,
  nodes: readonly CompiledWorkflowNode[],
  startIndex: number,
  deferredFinalReportIds: ReadonlySet<string>
): LangGraphEdge[] {
  return materializeLangGraphEdges(nodes, workflowExecutionPlanEdges({
    compiled: input.compiled,
    workflow: input.workflow,
    nodes,
    startIndex,
    deferredFinalReportIds,
    builtInMetadata: (node) => builtInMetadataForPolicyNode(input, node)
  }));
}

export const policyNode = workflowExecutionPlanPolicyNode;

export function builtInMetadataForPolicyNode(
  input: RunCompiledWorkflowInput,
  node: WorkflowExecutionPlanPolicyNode
): BuiltInStepMetadata {
  return input.builtInMetadata?.(node.compiled) ?? {};
}

function materializeLangGraphEdges(
  nodes: readonly CompiledWorkflowNode[],
  nodeEdges: readonly WorkflowExecutionPlanEdge[]
): LangGraphEdge[] {
  const edges = [...nodeEdges];
  for (const node of nodes) {
    const hasIncoming = nodeEdges.some((edge) => edge.to === node.id);
    if (!hasIncoming) {
      edges.push({ from: "__start__", to: node.id });
    }

    const hasOutgoing = nodeEdges.some((edge) => edge.from === node.id);
    if (!hasOutgoing) {
      edges.push({ from: node.id, to: "__end__" });
    }
  }

  return edges;
}
