import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

export type WorkflowTestScopeKind = "isolated_node" | "from_node"
export type WorkflowTestExecutionScope =
  | { readonly kind: "workflow" }
  | { readonly kind: "through_node" | WorkflowTestScopeKind; readonly node_id: string }

export type WorkflowTestScopeAvailability = {
  readonly boundaryNodeIds: readonly string[]
  readonly missingNodeIds: readonly string[]
  readonly available: boolean
}

function dependencies(node: WorkflowSourceNode): readonly string[] {
  return Array.isArray(node.value.after)
    ? node.value.after.filter((value): value is string => typeof value === "string")
    : []
}

function descendantIds(
  nodes: readonly WorkflowSourceNode[],
  selectedNodeId: string,
): ReadonlySet<string> {
  const dependents = new Map<string, string[]>()
  for (const node of nodes) {
    for (const dependency of dependencies(node)) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), node.id])
    }
  }
  const descendants = new Set<string>()
  const pending = [selectedNodeId]
  while (pending.length > 0) {
    const nodeId = pending.pop()
    if (nodeId === undefined || descendants.has(nodeId)) continue
    descendants.add(nodeId)
    pending.push(...(dependents.get(nodeId) ?? []))
  }
  return descendants
}

function ancestorIds(
  nodes: readonly WorkflowSourceNode[],
  selectedNodeId: string,
): ReadonlySet<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const ancestors = new Set<string>()
  const pending = [selectedNodeId]
  while (pending.length > 0) {
    const nodeId = pending.pop()
    if (nodeId === undefined || ancestors.has(nodeId)) continue
    ancestors.add(nodeId)
    const node = byId.get(nodeId)
    if (node !== undefined) pending.push(...dependencies(node))
  }
  return ancestors
}

export function workflowTestScopeAvailability(
  nodes: readonly WorkflowSourceNode[],
  selectedNodeId: string,
  kind: WorkflowTestScopeKind,
  activeTestDataNodeIds: ReadonlySet<string>,
): WorkflowTestScopeAvailability {
  const selected = kind === "isolated_node"
    ? new Set([selectedNodeId])
    : descendantIds(nodes, selectedNodeId)
  const boundaryNodeIds = nodes
    .filter((node) => selected.has(node.id))
    .flatMap(dependencies)
    .filter((nodeId, index, values) =>
      !selected.has(nodeId) && values.indexOf(nodeId) === index
    )
  const missingNodeIds = boundaryNodeIds.filter(
    (nodeId) => !activeTestDataNodeIds.has(nodeId),
  )
  return {
    boundaryNodeIds,
    missingNodeIds,
    available: missingNodeIds.length === 0,
  }
}

export function workflowTestDataNodeIdsForScope(
  nodes: readonly WorkflowSourceNode[],
  scope: WorkflowTestExecutionScope,
): ReadonlySet<string> | undefined {
  if (scope.kind === "workflow") return undefined
  if (scope.kind === "through_node") return ancestorIds(nodes, scope.node_id)
  return new Set(workflowTestScopeAvailability(
    nodes,
    scope.node_id,
    scope.kind,
    new Set(),
  ).boundaryNodeIds)
}
