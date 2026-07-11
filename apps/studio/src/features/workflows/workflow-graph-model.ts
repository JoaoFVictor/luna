export type WorkflowGraphNode = {
  readonly id: string
  readonly kind: "built_in" | "agent" | "pattern" | "interrupt"
  readonly capability_id: string
  readonly can_create_pending_interrupt: boolean
}

export type WorkflowGraphModel = {
  readonly nodes: readonly WorkflowGraphNode[]
  readonly edges: readonly { readonly from: string; readonly to: string }[]
}

type WorkflowGraphCandidate = {
  readonly nodes?: readonly {
    readonly id?: string
    readonly kind?: WorkflowGraphNode["kind"]
    readonly capability_id?: string
    readonly can_create_pending_interrupt?: boolean
  }[]
  readonly edges?: readonly { readonly from?: string; readonly to?: string }[]
}

export function workflowGraphModel(candidate: WorkflowGraphCandidate): WorkflowGraphModel {
  const nodes = (candidate.nodes ?? []).flatMap((node) =>
    node.id === undefined || node.kind === undefined || node.capability_id === undefined || node.can_create_pending_interrupt === undefined
      ? []
      : [{ id: node.id, kind: node.kind, capability_id: node.capability_id, can_create_pending_interrupt: node.can_create_pending_interrupt }],
  )
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = (candidate.edges ?? []).flatMap((edge) =>
    edge.from !== undefined && edge.to !== undefined && nodeIds.has(edge.from) && nodeIds.has(edge.to)
      ? [{ from: edge.from, to: edge.to }]
      : [],
  )
  return { nodes, edges }
}
