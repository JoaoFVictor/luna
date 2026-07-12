import type { JsonValue } from "@/api/types"

export type WorkflowNodePosition = { x: number; y: number }
export type WorkflowPositions = Readonly<Record<string, WorkflowNodePosition>>
export type WorkflowNodeNotes = Readonly<Record<string, string>>
export type WorkflowLayoutDirection = "vertical" | "horizontal"
export type WorkflowCanvasGroup = {
  readonly id: string
  readonly title: string
  readonly nodeIds: readonly string[]
}
export type WorkflowCanvasLayout = {
  readonly positions: WorkflowPositions
  readonly direction: WorkflowLayoutDirection
  readonly pinnedNodeIds: readonly string[]
  readonly groups: readonly WorkflowCanvasGroup[]
}
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

export function workflowCanvasLayout(layout: JsonValue | undefined): WorkflowCanvasLayout {
  const workflow = isRecord(layout) && isRecord(layout.workflow) ? layout.workflow : undefined
  const direction = workflow?.direction === "horizontal" ? "horizontal" : "vertical"
  const pinnedNodeIds = Array.isArray(workflow?.pinned_nodes)
    ? workflow.pinned_nodes.filter((value): value is string => typeof value === "string")
    : []
  const parsedGroups = Array.isArray(workflow?.groups)
    ? workflow.groups.flatMap((value): WorkflowCanvasGroup[] => {
      if (!isRecord(value) || typeof value.id !== "string" || value.id.trim() === "" || typeof value.title !== "string" || !Array.isArray(value.node_ids)) return []
      const nodeIds = value.node_ids.filter((nodeId): nodeId is string => typeof nodeId === "string" && nodeId.trim() !== "")
      return [{ id: value.id, title: value.title.trim() || value.id, nodeIds: [...new Set(nodeIds)] }]
    })
    : []
  const groups = parsedGroups.filter((group, index) => parsedGroups.findIndex((candidate) => candidate.id === group.id) === index)
  return { positions: workflowPositions(layout), direction, pinnedNodeIds: [...new Set(pinnedNodeIds)], groups }
}

export function withWorkflowCanvasLayout(
  layout: JsonValue | undefined,
  canvas: WorkflowCanvasLayout,
): JsonValue {
  const root = isRecord(layout) ? { ...layout } : {}
  const workflow = isRecord(root.workflow) ? { ...root.workflow } : {}
  return {
    ...root,
    workflow: {
      ...workflow,
      positions: canvas.positions,
      direction: canvas.direction,
      pinned_nodes: [...new Set(canvas.pinnedNodeIds)].sort(),
      groups: canvas.groups.map((group) => ({
        id: group.id,
        title: group.title,
        node_ids: [...new Set(group.nodeIds)],
      })),
    },
  }
}

export function workflowNodeNotes(layout: JsonValue | undefined): WorkflowNodeNotes {
  if (!isRecord(layout) || !isRecord(layout.workflow) || !isRecord(layout.workflow.notes)) {
    return {}
  }
  return Object.fromEntries(Object.entries(layout.workflow.notes).flatMap(([nodeId, value]) =>
    typeof value === "string" && value.trim().length > 0
      ? [[nodeId, value]]
      : [],
  ))
}

export function withWorkflowNodeNote(
  layout: JsonValue | undefined,
  nodeId: string,
  note: string,
): JsonValue {
  const root = isRecord(layout) ? { ...layout } : {}
  const workflow = isRecord(root.workflow) ? { ...root.workflow } : {}
  const notes = { ...workflowNodeNotes(layout) }
  if (note.trim().length === 0) delete notes[nodeId]
  else notes[nodeId] = note.trim()
  const nextWorkflow = { ...workflow }
  if (Object.keys(notes).length === 0) delete nextWorkflow.notes
  else nextWorkflow.notes = notes
  return { ...root, workflow: nextWorkflow }
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
