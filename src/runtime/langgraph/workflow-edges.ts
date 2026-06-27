import { END, START } from "@langchain/langgraph";
import type { BuiltInStepMetadata } from "../../core/built-ins/types.js";
import { runtimeError } from "../../core/runtime/errors.js";
import {
  selectReadyBatchWithPolicy,
  type WorkflowExecutionNode
} from "../../core/workflow/execution-policy.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import {
  dependenciesByNode,
  readyNodes
} from "../../core/workflow/runner-graph.js";
import type { RunCompiledWorkflowInput } from "./workflow-runner-types.js";

export type LangGraphEdge = {
  readonly from: string;
  readonly to: string;
};

type RunnerPolicyNode = WorkflowExecutionNode & {
  readonly compiled: CompiledWorkflowNode;
};

type PolicyEdgePlan = {
  readonly edges: LangGraphEdge[];
  readonly delayedNodeIds: ReadonlySet<string>;
};

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
  const nodeIds = new Set(nodes.map((node) => node.id));
  const mainNodeIds = new Set(
    nodes
      .filter((node) => !deferredFinalReportIds.has(node.id))
      .map((node) => node.id)
  );
  const edges = new Map<string, LangGraphEdge>();

  const addEdge = (from: string, to: string): void => {
    if ((from === "__start__" || nodeIds.has(from)) && (to === "__end__" || nodeIds.has(to))) {
      edges.set(`${from}->${to}`, { from, to });
    }
  };

  for (const edge of input.compiled.edges) {
    if (deferredFinalReportIds.has(edge.to) && mainNodeIds.size > 0) {
      continue;
    }

    addEdge(edge.from, edge.to);
  }

  if (deferredFinalReportIds.size > 0 && mainNodeIds.size > 0) {
    const mainTerminalIds = terminalNodeIds([...mainNodeIds], input.compiled.edges);
    for (const mainNodeId of mainTerminalIds) {
      for (const deferredNodeId of deferredFinalReportIds) {
        addEdge(mainNodeId, deferredNodeId);
      }
    }
  }

  const policyEdges = policyConcurrencyEdges(input, nodes, startIndex, deferredFinalReportIds);
  for (const delayedNodeId of policyEdges.delayedNodeIds) {
    for (const key of [...edges.keys()]) {
      if (edges.get(key)?.to === delayedNodeId) {
        edges.delete(key);
      }
    }
  }
  for (const edge of policyEdges.edges) {
    addEdge(edge.from, edge.to);
  }

  for (const node of nodes) {
    const hasIncoming = [...edges.values()].some((edge) => edge.to === node.id);
    if (!hasIncoming) {
      addEdge("__start__", node.id);
    }
  }

  return [...edges.values()];
}

function terminalNodeIds(
  nodeIds: readonly string[],
  edges: readonly LangGraphEdge[]
): string[] {
  const nodeIdSet = new Set(nodeIds);
  const nonTerminal = new Set(
    edges
      .filter((edge) => nodeIdSet.has(edge.from) && nodeIdSet.has(edge.to))
      .map((edge) => edge.from)
  );

  return nodeIds.filter((nodeId) => !nonTerminal.has(nodeId));
}

function policyConcurrencyEdges(
  input: RunCompiledWorkflowInput,
  nodes: readonly CompiledWorkflowNode[],
  startIndex: number,
  deferredFinalReportIds: ReadonlySet<string>
): PolicyEdgePlan {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const dependencies = dependenciesByNode(input.compiled, nodeIds);
  const pending = new Set(nodes.map((node) => node.id));
  const completed = new Set(input.compiled.nodes.slice(0, startIndex).map((node) => node.id));
  const edges: LangGraphEdge[] = [];
  const delayedNodeIds = new Set<string>();

  while (pending.size > 0) {
    const ready = runnableReadyNodes(
      nodes,
      dependencies,
      pending,
      completed,
      deferredFinalReportIds
    );
    if (ready.length === 0) {
      throw runtimeError("Workflow graph has no runnable nodes", "runtime_state_invalid", {
        details: {
          workflow_id: input.workflow.id,
          pending: [...pending]
        }
      });
    }

    const batch = selectReadyBatchWithPolicy({
      ready: ready.map(policyNode),
      maxConcurrency: input.workflow.execution.max_concurrency,
      builtInMetadata: (node) => builtInMetadataForPolicyNode(input, node)
    }).items.map((item) => item.node.compiled);
    if (batch.length === 0) {
      throw runtimeError("Workflow execution policy selected no runnable nodes", "runtime_state_invalid", {
        details: { workflow_id: input.workflow.id, pending: [...pending] }
      });
    }

    const blockedReady = ready.filter(
      (node) => !batch.some((batchNode) => batchNode.id === node.id)
    );
    for (const blocked of blockedReady) {
      delayedNodeIds.add(blocked.id);
      for (const running of batch) {
        edges.push({ from: running.id, to: blocked.id });
      }
    }

    for (const node of batch) {
      pending.delete(node.id);
      completed.add(node.id);
    }
  }

  return { edges, delayedNodeIds };
}

function runnableReadyNodes(
  nodes: readonly CompiledWorkflowNode[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  pending: ReadonlySet<string>,
  completed: ReadonlySet<string>,
  deferredFinalReportIds: ReadonlySet<string>
): CompiledWorkflowNode[] {
  const ready = readyNodes(nodes, dependencies, pending, completed);
  const hasPendingMainNodes = [...pending].some(
    (nodeId) => !deferredFinalReportIds.has(nodeId)
  );

  return hasPendingMainNodes
    ? ready.filter((node) => !deferredFinalReportIds.has(node.id))
    : ready;
}

export function policyNode(node: CompiledWorkflowNode): RunnerPolicyNode {
  return {
    id: node.id,
    type: policyNodeType(node),
    after: afterFromCompiledNode(node),
    artifacts: node.source.type === "built_in" ||
      node.source.type === "agent" ||
      node.source.type === "pattern" ||
      node.source.type === "human_gate"
      ? node.source.artifacts
      : undefined,
    ...(node.source.type === "built_in" ? { uses: node.source.uses } : {}),
    compiled: node
  };
}

function policyNodeType(
  node: CompiledWorkflowNode
): WorkflowExecutionNode["type"] {
  if (node.kind === "agent") {
    return "agent";
  }
  if (node.kind === "pattern") {
    return "gated_agent_loop";
  }

  return "built_in";
}

function afterFromCompiledNode(node: CompiledWorkflowNode): string[] | undefined {
  return node.source.type === "built_in" ||
    node.source.type === "agent" ||
    node.source.type === "pattern" ||
    node.source.type === "human_gate"
    ? [...(node.source.after ?? [])]
    : undefined;
}

export function builtInMetadataForPolicyNode(
  input: RunCompiledWorkflowInput,
  node: RunnerPolicyNode
): BuiltInStepMetadata {
  return input.builtInMetadata?.(node.compiled) ?? {};
}
