export type WorkflowGraphNode = {
  readonly id: string
  readonly kind: "built_in" | "agent" | "pattern" | "interrupt" | "workflow" | "loop"
  readonly capability_id: string
  readonly can_create_pending_interrupt: boolean
  readonly loop_body?: readonly WorkflowGraphNode[]
}

export type WorkflowGraphModel = {
  readonly nodes: readonly WorkflowGraphNode[]
  readonly edges: readonly { readonly from: string; readonly to: string }[]
}

type WorkflowGraphNodeCandidate = {
  readonly id?: string
  readonly kind?: WorkflowGraphNode["kind"]
  readonly capability_id?: string
  readonly can_create_pending_interrupt?: boolean
  readonly loop_body?: readonly WorkflowGraphNodeCandidate[]
}

type WorkflowGraphCandidate = {
  readonly nodes?: readonly {
    readonly id?: WorkflowGraphNodeCandidate["id"]
    readonly kind?: WorkflowGraphNodeCandidate["kind"]
    readonly capability_id?: WorkflowGraphNodeCandidate["capability_id"]
    readonly can_create_pending_interrupt?: WorkflowGraphNodeCandidate["can_create_pending_interrupt"]
    readonly loop_body?: WorkflowGraphNodeCandidate["loop_body"]
  }[]
  readonly edges?: readonly { readonly from?: string; readonly to?: string }[]
}

export function workflowGraphModel(candidate: WorkflowGraphCandidate): WorkflowGraphModel {
  const projectNode = (node: WorkflowGraphNodeCandidate): WorkflowGraphNode | undefined => {
    if (node.id === undefined || node.kind === undefined || node.capability_id === undefined || node.can_create_pending_interrupt === undefined) return undefined
    const loopBody = (node.loop_body ?? []).flatMap((bodyNode) => {
      const projected = projectNode(bodyNode)
      return projected === undefined ? [] : [projected]
    })
    return {
      id: node.id,
      kind: node.kind,
      capability_id: node.capability_id,
      can_create_pending_interrupt: node.can_create_pending_interrupt,
      ...(node.kind === "loop" ? { loop_body: loopBody } : {}),
    }
  }
  const nodes = (candidate.nodes ?? []).flatMap((node) => {
    const projected = projectNode(node)
    return projected === undefined ? [] : [projected]
  })
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = (candidate.edges ?? []).flatMap((edge) =>
    edge.from !== undefined && edge.to !== undefined && nodeIds.has(edge.from) && nodeIds.has(edge.to)
      ? [{ from: edge.from, to: edge.to }]
      : [],
  )
  return { nodes, edges }
}
