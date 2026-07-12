import { z } from "zod";
import type { WorkflowDefinition, WorkflowNode } from "./definition-types.js";

export const WorkflowExecutionScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workflow") }).strict(),
  z.object({
    kind: z.literal("through_node"),
    node_id: z.string().min(1).max(256)
  }).strict(),
  z.object({
    kind: z.literal("isolated_node"),
    node_id: z.string().min(1).max(256)
  }).strict(),
  z.object({
    kind: z.literal("from_node"),
    node_id: z.string().min(1).max(256)
  }).strict()
]);
export type WorkflowExecutionScope = z.infer<typeof WorkflowExecutionScopeSchema>;

export function workflowExecutionScopesEqual(
  left: WorkflowExecutionScope,
  right: WorkflowExecutionScope
): boolean {
  return left.kind === right.kind && (
    left.kind === "workflow" || (
      right.kind !== "workflow" && left.node_id === right.node_id
    )
  );
}

export class WorkflowExecutionScopeError extends Error {
  readonly nodeId: string;

  constructor(nodeId: string) {
    super(`Workflow execution scope references unknown node: ${nodeId}`);
    this.name = "WorkflowExecutionScopeError";
    this.nodeId = nodeId;
  }
}

export class WorkflowExecutionScopeFixtureError extends Error {
  readonly nodeId: string;
  readonly missingNodeIds: readonly string[];

  constructor(nodeId: string, missingNodeIds: readonly string[]) {
    super(
      `Workflow execution scope for ${nodeId} requires saved outputs for: ${missingNodeIds.join(", ")}`
    );
    this.name = "WorkflowExecutionScopeFixtureError";
    this.nodeId = nodeId;
    this.missingNodeIds = missingNodeIds;
  }
}

function workflowAncestors(
  nodes: readonly WorkflowNode[],
  targetId: string
): ReadonlySet<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (!byId.has(targetId)) throw new WorkflowExecutionScopeError(targetId);
  const included = new Set<string>();
  const pending = [targetId];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined || included.has(nodeId)) continue;
    included.add(nodeId);
    for (const dependency of byId.get(nodeId)?.after ?? []) pending.push(dependency);
  }
  return included;
}

function workflowDescendants(
  nodes: readonly WorkflowNode[],
  targetId: string
): ReadonlySet<string> {
  if (!nodes.some((node) => node.id === targetId)) {
    throw new WorkflowExecutionScopeError(targetId);
  }
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.after ?? []) {
      const current = dependents.get(dependency) ?? [];
      current.push(node.id);
      dependents.set(dependency, current);
    }
  }
  const included = new Set<string>();
  const pending = [targetId];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined || included.has(nodeId)) continue;
    included.add(nodeId);
    for (const dependent of dependents.get(nodeId) ?? []) pending.push(dependent);
  }
  return included;
}

export function workflowExecutionScopeBoundaryNodeIds(
  workflow: WorkflowDefinition,
  scope: WorkflowExecutionScope
): readonly string[] {
  if (scope.kind === "workflow" || scope.kind === "through_node") return [];
  const selected = scope.kind === "isolated_node"
    ? new Set([scope.node_id])
    : workflowDescendants(workflow.graph.nodes, scope.node_id);
  if (scope.kind === "isolated_node" && !workflow.graph.nodes.some(
    (node) => node.id === scope.node_id
  )) {
    throw new WorkflowExecutionScopeError(scope.node_id);
  }
  return workflow.graph.nodes
    .filter((node) => selected.has(node.id))
    .flatMap((node) => node.after ?? [])
    .filter((nodeId, index, values) =>
      !selected.has(nodeId) && values.indexOf(nodeId) === index
    );
}

export function scopeWorkflowDefinition(
  workflow: WorkflowDefinition,
  scope: WorkflowExecutionScope,
  precompletedNodeIds: ReadonlySet<string> = new Set()
): WorkflowDefinition {
  if (scope.kind === "workflow") return workflow;
  const included = new Set(scope.kind === "through_node"
    ? workflowAncestors(workflow.graph.nodes, scope.node_id)
    : scope.kind === "isolated_node"
      ? [scope.node_id]
      : workflowDescendants(workflow.graph.nodes, scope.node_id));
  const boundary = workflowExecutionScopeBoundaryNodeIds(workflow, scope);
  const missingBoundary = boundary.filter((nodeId) => !precompletedNodeIds.has(nodeId));
  if (missingBoundary.length > 0) {
    throw new WorkflowExecutionScopeFixtureError(scope.node_id, missingBoundary);
  }
  for (const nodeId of boundary) included.add(nodeId);
  return {
    ...workflow,
    graph: {
      ...workflow.graph,
      nodes: workflow.graph.nodes.filter((node) => included.has(node.id))
    }
  };
}
