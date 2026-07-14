import type {
  WorkflowDefinition,
  WorkflowNode
} from "./definition-types.js";

export type ComposedWorkflowNode = {
  readonly workflow: WorkflowDefinition;
  readonly node: WorkflowNode;
  readonly qualifiedNodeId: string;
  /** Parent-runtime node whose start is the recovery boundary for this node. */
  readonly executionBoundaryNodeId: string;
};

/**
 * Projects a composition tree into one deterministic list without changing
 * the executable node ids stored in any individual workflow.
 */
export function composedWorkflowNodes(
  root: WorkflowDefinition
): readonly ComposedWorkflowNode[] {
  const result: ComposedWorkflowNode[] = [];

  function visitNodes(
    workflow: WorkflowDefinition,
    nodes: readonly WorkflowNode[],
    prefix: string,
    inheritedExecutionBoundary?: string
  ): void {
    for (const node of nodes) {
      const segment = encodeURIComponent(node.id);
      const qualifiedNodeId = prefix === "" ? segment : `${prefix}/${segment}`;
      const executionBoundaryNodeId = inheritedExecutionBoundary ?? (
        prefix === "" ? node.id : qualifiedNodeId
      );
      result.push({ workflow, node, qualifiedNodeId, executionBoundaryNodeId });
      if (node.type === "loop") {
        visitNodes(
          workflow,
          node.body.nodes,
          qualifiedNodeId,
          inheritedExecutionBoundary
        );
      }
      if (node.type === "workflow") {
        const child = workflow.compositions?.[node.workflow];
        if (child !== undefined) {
          visitNodes(
            child,
            child.graph.nodes,
            qualifiedNodeId,
            executionBoundaryNodeId
          );
        }
      }
    }
  }

  visitNodes(root, root.graph.nodes, "");
  return result;
}
