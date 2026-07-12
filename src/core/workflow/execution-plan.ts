import type { BuiltInStepMetadata } from "../built-ins/types.js";
import { runtimeError } from "../runtime/errors.js";
import type { WorkflowDefinition } from "./definition-types.js";
import {
  selectReadyBatchWithPolicy,
  type WorkflowExecutionNode
} from "./execution-policy.js";
import type { CompiledWorkflow, CompiledWorkflowNode } from "./compiler.js";
import {
  dependenciesByNode,
  readyNodes
} from "./runner-graph.js";

export type WorkflowExecutionPlanEdge = {
  readonly from: string;
  readonly to: string;
};

export type WorkflowExecutionPlanPolicyNode = WorkflowExecutionNode & {
  readonly compiled: CompiledWorkflowNode;
};

export type WorkflowExecutionPlanInput = {
  readonly compiled: CompiledWorkflow;
  readonly workflow: Pick<WorkflowDefinition, "id" | "execution">;
  readonly nodes: readonly CompiledWorkflowNode[];
  readonly startIndex: number;
  readonly deferredFinalReportIds: ReadonlySet<string>;
  readonly builtInMetadata: (
    node: WorkflowExecutionPlanPolicyNode
  ) => BuiltInStepMetadata;
};

type PolicyEdgePlan = {
  readonly edges: WorkflowExecutionPlanEdge[];
  readonly delayedNodeIds: ReadonlySet<string>;
};

export function workflowExecutionPlanEdges({
  compiled,
  workflow,
  nodes,
  startIndex,
  deferredFinalReportIds,
  builtInMetadata
}: WorkflowExecutionPlanInput): WorkflowExecutionPlanEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const mainNodeIds = new Set(
    nodes
      .filter((node) => !deferredFinalReportIds.has(node.id))
      .map((node) => node.id)
  );
  const edges = new Map<string, WorkflowExecutionPlanEdge>();

  const addEdge = (from: string, to: string): void => {
    if (nodeIds.has(from) && nodeIds.has(to)) {
      edges.set(`${from}->${to}`, { from, to });
    }
  };

  for (const edge of compiled.edges) {
    if (deferredFinalReportIds.has(edge.to) && mainNodeIds.size > 0) {
      continue;
    }

    addEdge(edge.from, edge.to);
  }

  if (deferredFinalReportIds.size > 0 && mainNodeIds.size > 0) {
    const mainTerminalIds = terminalNodeIds([...mainNodeIds], compiled.edges);
    for (const mainNodeId of mainTerminalIds) {
      for (const deferredNodeId of deferredFinalReportIds) {
        addEdge(mainNodeId, deferredNodeId);
      }
    }
  }

  const policyEdges = policyConcurrencyEdges({
    compiled,
    workflow,
    nodes,
    startIndex,
    deferredFinalReportIds,
    builtInMetadata
  });
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

  return [...edges.values()];
}

export function workflowExecutionPlanPolicyNode(
  node: CompiledWorkflowNode
): WorkflowExecutionPlanPolicyNode {
  return {
    id: node.id,
    type: policyNodeType(node),
    after: afterFromCompiledNode(node),
    batchExclusionKeys: node.execution_policy?.batch_exclusion_keys,
    artifacts: node.source.type === "built_in" ||
      node.source.type === "agent" ||
      node.source.type === "pattern" ||
      node.source.type === "human_gate" ||
      node.source.type === "workflow"
      ? node.source.artifacts
      : undefined,
    ...(node.source.type === "built_in" ? { uses: node.source.uses } : {}),
    compiled: node
  };
}

function terminalNodeIds(
  nodeIds: readonly string[],
  edges: readonly WorkflowExecutionPlanEdge[]
): string[] {
  const nodeIdSet = new Set(nodeIds);
  const nonTerminal = new Set(
    edges
      .filter((edge) => nodeIdSet.has(edge.from) && nodeIdSet.has(edge.to))
      .map((edge) => edge.from)
  );

  return nodeIds.filter((nodeId) => !nonTerminal.has(nodeId));
}

function policyConcurrencyEdges({
  compiled,
  workflow,
  nodes,
  startIndex,
  deferredFinalReportIds,
  builtInMetadata
}: WorkflowExecutionPlanInput): PolicyEdgePlan {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const dependencies = dependenciesByNode(compiled, nodeIds);
  const pending = new Set(nodes.map((node) => node.id));
  const completed = new Set(compiled.nodes.slice(0, startIndex).map((node) => node.id));
  const edges: WorkflowExecutionPlanEdge[] = [];
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
          workflow_id: workflow.id,
          pending: [...pending]
        }
      });
    }

    const batch = selectReadyBatchWithPolicy({
      ready: ready.map(workflowExecutionPlanPolicyNode),
      maxConcurrency: workflow.execution.max_concurrency,
      builtInMetadata
    }).items.map((item) => item.node.compiled);
    if (batch.length === 0) {
      throw runtimeError("Workflow execution policy selected no runnable nodes", "runtime_state_invalid", {
        details: { workflow_id: workflow.id, pending: [...pending] }
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

function policyNodeType(
  node: CompiledWorkflowNode
): WorkflowExecutionNode["type"] {
  if (node.kind === "agent") {
    return "agent";
  }
  if (node.kind === "pattern") {
    return "pattern";
  }

  return "built_in";
}

function afterFromCompiledNode(node: CompiledWorkflowNode): string[] | undefined {
  return node.source.type === "built_in" ||
    node.source.type === "agent" ||
    node.source.type === "pattern" ||
    node.source.type === "human_gate" ||
    node.source.type === "workflow"
    ? [...(node.source.after ?? [])]
    : undefined;
}
