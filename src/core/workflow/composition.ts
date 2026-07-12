import type {
  WorkflowDefinition,
  WorkflowNode
} from "./definition-types.js";

export type ComposedWorkflowNode = {
  readonly workflow: WorkflowDefinition;
  readonly node: WorkflowNode;
  readonly qualifiedNodeId: string;
};

/**
 * Projects a composition tree into one deterministic list without changing
 * the executable node ids stored in any individual workflow.
 */
export function composedWorkflowNodes(
  root: WorkflowDefinition
): readonly ComposedWorkflowNode[] {
  const result: ComposedWorkflowNode[] = [];

  function visit(workflow: WorkflowDefinition, prefix: string): void {
    for (const node of workflow.graph.nodes) {
      const segment = encodeURIComponent(node.id);
      const qualifiedNodeId = prefix === "" ? segment : `${prefix}/${segment}`;
      result.push({ workflow, node, qualifiedNodeId });
      if (node.type === "workflow") {
        const child = workflow.compositions?.[node.workflow];
        if (child !== undefined) visit(child, qualifiedNodeId);
      }
    }
  }

  visit(root, "");
  return result;
}
