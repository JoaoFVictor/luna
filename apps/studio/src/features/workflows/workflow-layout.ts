import type { JsonValue } from "@/api/types"

export type WorkflowNodePosition = { x: number; y: number }
export type WorkflowPositions = Readonly<Record<string, WorkflowNodePosition>>
export type WorkflowGraphShape = {
  readonly nodes: readonly { readonly id: string }[]
  readonly edges: readonly {
    readonly from: string
    readonly to: string
  }[]
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function workflowPositions(layout: JsonValue | undefined): WorkflowPositions {
  if (!isRecord(layout) || !isRecord(layout.workflow) || !isRecord(layout.workflow.positions)) {
    return {}
  }
  const positions: Record<string, WorkflowNodePosition> = Object.create(null)
  for (const [id, value] of Object.entries(layout.workflow.positions)) {
    if (
      isRecord(value) &&
      typeof value.x === "number" &&
      Number.isFinite(value.x) &&
      typeof value.y === "number" &&
      Number.isFinite(value.y)
    ) {
      positions[id] = { x: value.x, y: value.y }
    }
  }
  return positions
}

export function withWorkflowPositions(
  layout: JsonValue | undefined,
  positions: WorkflowPositions,
): JsonValue {
  const root = isRecord(layout) ? { ...layout } : {}
  const workflow = isRecord(root.workflow) ? { ...root.workflow } : {}
  return { ...root, workflow: { ...workflow, positions } }
}

export function autoWorkflowPositions(compiled: WorkflowGraphShape): WorkflowPositions {
  const ranks = workflowNodeRanks(compiled)
  const byRank = new Map<number, Array<{ readonly id: string }>>()
  for (const node of compiled.nodes) {
    const rank = ranks.get(node.id) ?? 0
    byRank.set(rank, [...(byRank.get(rank) ?? []), node])
  }
  const positions: Record<string, WorkflowNodePosition> = Object.create(null)
  for (const [rank, nodes] of byRank) {
    const ordered = [...nodes].sort((left, right) => left.id.localeCompare(right.id))
    ordered.forEach((node, index) => {
      positions[node.id] = {
        x: index * 250 - ((ordered.length - 1) * 250) / 2,
        y: rank * 145,
      }
    })
  }
  return positions
}

export function workflowNodeRanks(compiled: WorkflowGraphShape): ReadonlyMap<string, number> {
  const ranks = new Map(compiled.nodes.map((node) => [node.id, 0]))
  for (let pass = 0; pass < compiled.nodes.length; pass += 1) {
    let changed = false
    for (const edge of compiled.edges) {
      const candidate = (ranks.get(edge.from) ?? 0) + 1
      if (candidate > (ranks.get(edge.to) ?? 0)) {
        ranks.set(edge.to, candidate)
        changed = true
      }
    }
    if (!changed) break
  }
  return ranks
}
