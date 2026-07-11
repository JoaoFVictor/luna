export type WorkflowGraphAnalysisNode = {
  id: string;
  type: string;
  after?: readonly string[];
};

export type WorkflowGraphAnalysis = {
  topological_node_ids: string[];
};

type GraphAnalysisCode =
  | "workflow_node_duplicate"
  | "workflow_reference_unknown"
  | "workflow_cycle_detected";

export class WorkflowGraphAnalysisError extends Error {
  readonly code: GraphAnalysisCode;
  readonly path?: string;
  readonly nodeId?: string;
  readonly edge?: { readonly from: string; readonly to: string };

  constructor(
    code: GraphAnalysisCode,
    message: string,
    options: {
      readonly path?: string;
      readonly nodeId?: string;
      readonly edge?: { readonly from: string; readonly to: string };
    } = {}
  ) {
    super(message);
    this.name = "WorkflowGraphAnalysisError";
    this.code = code;
    this.path = options.path;
    this.nodeId = options.nodeId;
    this.edge = options.edge;
  }
}

export function analyzeWorkflowGraph({
  nodes
}: {
  nodes: readonly WorkflowGraphAnalysisNode[];
}): WorkflowGraphAnalysis {
  const byId = new Map<string, WorkflowGraphAnalysisNode>();
  nodes.forEach((node, index) => {
    if (byId.has(node.id)) {
      throw new WorkflowGraphAnalysisError(
        "workflow_node_duplicate",
        `Duplicate workflow node id: ${node.id}`,
        { path: `$.nodes[${index}].id`, nodeId: node.id }
      );
    }
    byId.set(node.id, node);
  });

  nodes.forEach((node, index) => {
    (node.after ?? []).forEach((dependency, dependencyIndex) => {
      if (!byId.has(dependency)) {
        throw new WorkflowGraphAnalysisError(
          "workflow_reference_unknown",
          `Workflow node ${node.id} depends on unknown node ${dependency}.`,
          {
            path: `$.nodes[${index}].after[${dependencyIndex}]`,
            nodeId: node.id,
            edge: { from: dependency, to: node.id }
          }
        );
      }
    });
  });

  const topologicalNodeIds = topologicalOrder(nodes, byId);

  return { topological_node_ids: topologicalNodeIds };
}

function topologicalOrder(
  nodes: readonly WorkflowGraphAnalysisNode[],
  byId: ReadonlyMap<string, WorkflowGraphAnalysisNode>
): string[] {
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string, path: readonly string[]): void {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new WorkflowGraphAnalysisError(
        "workflow_cycle_detected",
        `Workflow graph contains a cycle: ${[...path, id].join(" -> ")}.`,
        { nodeId: id }
      );
    }

    visiting.add(id);
    for (const dependency of byId.get(id)?.after ?? []) {
      visit(dependency, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  }

  for (const node of nodes) {
    visit(node.id, []);
  }

  return ordered;
}
