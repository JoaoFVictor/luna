import type { WorkflowDefinition, WorkflowNode } from "./definition-types.js";

export type PrecompletedWorkflowExecutionPlan = {
  /** The effective DAG. Precompleted cut points remain addressable but have no dependencies. */
  readonly workflow: WorkflowDefinition;
  /** Nodes whose executors may run, in workflow declaration order. */
  readonly executable_node_ids: ReadonlySet<string>;
};

/**
 * Builds the effective DAG for precompleted node outputs.
 *
 * Traversal starts at the terminals in the requested scope and stops at each
 * precompleted cut point. A shared ancestor remains when another executable
 * terminal still depends on it. Cut points remain in the graph so their output
 * schemas and downstream dependencies stay explicit, but their own dependencies
 * are cleared and they are omitted from `executable_node_ids`.
 */
export function planPrecompletedWorkflowExecution(
  workflow: WorkflowDefinition,
  precompletedNodeIds: ReadonlySet<string>,
  scopeNodeIds: ReadonlySet<string> = new Set(
    workflow.graph.nodes.map((node) => node.id)
  )
): PrecompletedWorkflowExecutionPlan {
  const scopedNodes = workflow.graph.nodes.filter((node) =>
    scopeNodeIds.has(node.id)
  );
  if (precompletedNodeIds.size === 0) {
    return {
      workflow: scopedWorkflow(workflow, scopedNodes),
      executable_node_ids: new Set(scopedNodes.map((node) => node.id))
    };
  }

  const scopedIds = new Set(scopedNodes.map((node) => node.id));
  const dependencyIds = new Set(
    scopedNodes.flatMap((node) =>
      (node.after ?? []).filter((dependency) => scopedIds.has(dependency))
    )
  );
  const byId = new Map(scopedNodes.map((node) => [node.id, node]));
  const included = new Set<string>();
  const pending = scopedNodes
    .filter((node) => !dependencyIds.has(node.id))
    .map((node) => node.id);

  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined || included.has(nodeId)) continue;
    included.add(nodeId);
    if (precompletedNodeIds.has(nodeId)) continue;
    for (const dependency of byId.get(nodeId)?.after ?? []) {
      if (scopedIds.has(dependency)) pending.push(dependency);
    }
  }

  const effectiveNodes = scopedNodes
    .filter((node) => included.has(node.id))
    .map((node) =>
      precompletedNodeIds.has(node.id) && (node.after?.length ?? 0) > 0
        ? { ...node, after: [] }
        : node
    );
  return {
    workflow: scopedWorkflow(workflow, effectiveNodes),
    executable_node_ids: new Set(
      effectiveNodes
        .filter((node) => !precompletedNodeIds.has(node.id))
        .map((node) => node.id)
    )
  };
}

function scopedWorkflow(
  workflow: WorkflowDefinition,
  nodes: readonly WorkflowNode[]
): WorkflowDefinition {
  if (
    nodes.length === workflow.graph.nodes.length &&
    nodes.every((node, index) => node === workflow.graph.nodes[index])
  ) {
    return workflow;
  }
  return {
    ...workflow,
    graph: { ...workflow.graph, nodes: [...nodes] }
  };
}
