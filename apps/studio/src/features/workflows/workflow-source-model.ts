import type {
  JsonValue,
  YamlSourceOperation,
} from "@/api/types"

export type WorkflowSourceNode = {
  index: number
  id: string
  type: "built_in" | "agent" | "pattern" | "human_gate" | "workflow"
  registrationId: string
  value: Record<string, JsonValue>
}

export type WorkflowSourceOutlineEntry = {
  index: number
  selectionId: string
  label: string
  typeLabel: string
  registrationLabel: string
  problems: readonly string[]
  raw: JsonValue
  node?: WorkflowSourceNode
}

export type WorkflowSourceGraph = {
  readonly nodes: readonly {
    readonly id: string
    readonly kind: "built_in" | "agent" | "pattern" | "interrupt" | "workflow"
    readonly capability_id: string
    readonly can_create_pending_interrupt: boolean
  }[]
  readonly edges: readonly {
    readonly from: string
    readonly to: string
  }[]
}

// Mirrors StudioYamlSourceOperationsRequestSchema. Keep batches within the API contract.
export const STUDIO_YAML_SOURCE_OPERATION_LIMIT = 64

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nodeType(value: JsonValue | undefined): WorkflowSourceNode["type"] | undefined {
  return value === "built_in" || value === "agent" || value === "pattern" || value === "human_gate" || value === "workflow"
    ? value
    : undefined
}

export function workflowSourceNodes(source: JsonValue): WorkflowSourceNode[] {
  if (!isRecord(source) || !Array.isArray(source.nodes)) return []
  return source.nodes.flatMap((value, index) => {
    if (!isRecord(value) || typeof value.id !== "string") return []
    const type = nodeType(value.type)
    const registrationId = type === "agent"
      ? value.agent
      : type === "workflow"
        ? value.workflow
        : value.uses
    return type === undefined || typeof registrationId !== "string"
      ? []
      : [{ index, id: value.id, type, registrationId, value }]
  })
}

export function workflowSourceOutlineEntries(
  source: JsonValue,
): WorkflowSourceOutlineEntry[] {
  if (!isRecord(source) || !Array.isArray(source.nodes)) return []
  const nodes = workflowSourceNodes(source)
  const nodesByIndex = new Map(nodes.map((node) => [node.index, node]))
  const idCounts = new Map<string, number>()
  for (const value of source.nodes) {
    if (isRecord(value) && typeof value.id === "string" && value.id.length > 0) {
      idCounts.set(value.id, (idCounts.get(value.id) ?? 0) + 1)
    }
  }

  return source.nodes.map((raw, index) => {
    const value = isRecord(raw) ? raw : undefined
    const id = typeof value?.id === "string" && value.id.length > 0
      ? value.id
      : undefined
    const type = nodeType(value?.type)
    const rawType = typeof value?.type === "string" ? value.type : undefined
    const registration = type === "agent"
      ? value?.agent
      : type === "workflow"
        ? value?.workflow
        : type === undefined
          ? value?.agent ?? value?.workflow ?? value?.uses
          : value?.uses
    const node = nodesByIndex.get(index)
    const problems: string[] = []
    if (value === undefined) problems.push("O node deve ser um mapping YAML.")
    if (id === undefined) problems.push("O node precisa de um id não vazio.")
    if (type === undefined) problems.push("O node precisa de um type reconhecido.")
    if (typeof registration !== "string" || registration.length === 0) {
      problems.push(type === "agent"
        ? "O node precisa de agent."
        : type === "workflow"
          ? "O node precisa de workflow."
          : "O node precisa de uses.")
    }
    const duplicateId = id !== undefined && (idCounts.get(id) ?? 0) > 1
    if (duplicateId) problems.push(`O id ${id} está duplicado.`)

    return {
      index,
      selectionId: node !== undefined && !duplicateId
        ? node.id
        : `source-node:${index}`,
      label: id ?? `Node ${index + 1} (id ausente)`,
      typeLabel: type ?? (rawType === undefined ? "tipo ausente" : `${rawType} (inválido)`),
      registrationLabel: typeof registration === "string" && registration.length > 0
        ? registration
        : "registration ausente",
      problems,
      raw,
      ...(node === undefined ? {} : { node }),
    }
  })
}

export function workflowSourceCapabilities(source: JsonValue): string[] {
  if (!isRecord(source) || !Array.isArray(source.capabilities)) return []
  return source.capabilities.filter((value): value is string => typeof value === "string")
}

export function workflowSourceGraph(
  nodes: readonly WorkflowSourceNode[],
): WorkflowSourceGraph {
  const knownIds = new Set(nodes.map((node) => node.id))
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.type === "human_gate" ? "interrupt" : node.type,
      capability_id: node.type === "workflow" ? `workflow:${node.registrationId}` : node.registrationId,
      can_create_pending_interrupt: node.type === "human_gate",
    })),
    edges: nodes.flatMap((node) => {
      const after = workflowNodeField(node, "after")
      return Array.isArray(after)
        ? after.flatMap((dependency) =>
            typeof dependency === "string" && knownIds.has(dependency)
              ? [{ from: dependency, to: node.id }]
              : [],
          )
        : []
    }),
  }
}

export function connectWorkflowNodesOperations(
  nodes: readonly WorkflowSourceNode[],
  sourceId: string,
  targetId: string,
): YamlSourceOperation[] {
  const source = nodes.find((node) => node.id === sourceId)
  const target = nodes.find((node) => node.id === targetId)
  if (
    source === undefined ||
    target === undefined ||
    sourceId === targetId ||
    workflowDependencyWouldCycle(nodes, targetId, sourceId)
  ) {
    return []
  }
  const after = workflowNodeField(target, "after")
  const dependencies = Array.isArray(after)
    ? after.filter((value): value is string => typeof value === "string")
    : []
  if (dependencies.includes(sourceId)) return []
  return [{
    op: "set",
    path: ["nodes", target.index, "after"],
    value: [...dependencies, sourceId],
  }]
}

export function disconnectWorkflowNodesOperations(
  nodes: readonly WorkflowSourceNode[],
  sourceId: string,
  targetId: string,
): YamlSourceOperation[] {
  const target = nodes.find((node) => node.id === targetId)
  if (target === undefined) return []
  const after = workflowNodeField(target, "after")
  if (!Array.isArray(after)) return []
  const dependencies = after.filter(
    (value): value is string => typeof value === "string",
  )
  if (!dependencies.includes(sourceId)) return []
  const next = dependencies.filter((dependency) => dependency !== sourceId)
  return [next.length === 0
    ? { op: "delete", path: ["nodes", target.index, "after"] }
    : { op: "set", path: ["nodes", target.index, "after"], value: next }]
}

export function removeWorkflowNodeOperations(
  nodes: readonly WorkflowSourceNode[],
  nodeId: string,
): YamlSourceOperation[] {
  return removeWorkflowNodesOperations(nodes, [nodeId])
}

export function removeWorkflowNodesOperations(
  nodes: readonly WorkflowSourceNode[],
  nodeIds: readonly string[],
): YamlSourceOperation[] {
  const knownIds = new Set(nodes.map((node) => node.id))
  const removedIds = new Set(nodeIds.filter((nodeId) => knownIds.has(nodeId)))
  if (removedIds.size === 0) return []

  const dependencyUpdates = nodes.flatMap<YamlSourceOperation>((node) => {
    if (removedIds.has(node.id)) return []
    const after = workflowNodeField(node, "after")
    if (!Array.isArray(after) || !after.some((dependency) =>
      typeof dependency === "string" && removedIds.has(dependency)
    )) return []
    const remaining = after.filter((dependency) =>
      typeof dependency !== "string" || !removedIds.has(dependency)
    )
    return [remaining.length === 0
      ? { op: "delete", path: ["nodes", node.index, "after"] }
      : { op: "set", path: ["nodes", node.index, "after"], value: remaining }]
  })
  const removals = nodes
    .filter((node) => removedIds.has(node.id))
    .sort((left, right) => right.index - left.index)
    .map<YamlSourceOperation>((node) => ({
      op: "sequence_remove",
      path: ["nodes"],
      index: node.index,
    }))
  return [
    ...dependencyUpdates,
    ...removals,
  ]
}

function nodesWithoutDependency(
  nodes: readonly WorkflowSourceNode[],
  sourceId: string,
  targetId: string,
): WorkflowSourceNode[] {
  return nodes.map((node) => {
    if (node.id !== targetId) return node
    const after = workflowNodeField(node, "after")
    if (!Array.isArray(after)) return node
    const next = after.filter((value) => value !== sourceId)
    const value = { ...node.value }
    if (next.length === 0) delete value.after
    else value.after = next
    return { ...node, value }
  })
}

export function reconnectWorkflowNodesOperations(
  nodes: readonly WorkflowSourceNode[],
  previousSourceId: string,
  previousTargetId: string,
  nextSourceId: string,
  nextTargetId: string,
): YamlSourceOperation[] {
  if (previousSourceId === nextSourceId && previousTargetId === nextTargetId) return []
  const disconnect = disconnectWorkflowNodesOperations(nodes, previousSourceId, previousTargetId)
  if (disconnect.length === 0) return []
  const disconnectedNodes = nodesWithoutDependency(nodes, previousSourceId, previousTargetId)
  const connect = connectWorkflowNodesOperations(disconnectedNodes, nextSourceId, nextTargetId)
  return connect.length === 0 ? [] : [...disconnect, ...connect]
}

export function addWorkflowCapabilityOperations(
  source: JsonValue,
  capabilityIds: readonly (string | undefined)[],
): YamlSourceOperation[] {
  const declared = new Set(workflowSourceCapabilities(source))
  const operations: YamlSourceOperation[] = []
  for (const capabilityId of capabilityIds) {
    if (capabilityId === undefined || declared.has(capabilityId)) continue
    declared.add(capabilityId)
    operations.push({ op: "sequence_insert", path: ["capabilities"], value: capabilityId })
  }
  return operations
}

export function ensureWorkflowRepositoryRequirementOperations(
  source: JsonValue,
  required: boolean,
): YamlSourceOperation[] {
  if (!required || !isRecord(source)) return []
  const requires = source.requires
  if (isRecord(requires) && requires.repository === true) return []
  return [isRecord(requires)
    ? { op: "set", path: ["requires", "repository"], value: true }
    : { op: "set", path: ["requires"], value: { repository: true } }]
}

export function workflowNodeField(
  node: WorkflowSourceNode,
  field: string,
): JsonValue | undefined {
  return Object.hasOwn(node.value, field) ? node.value[field] : undefined
}

export function workflowDependencyWouldCycle(
  nodes: readonly WorkflowSourceNode[],
  nodeId: string,
  dependencyId: string,
): boolean {
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const pending = [dependencyId]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) continue
    if (current === nodeId) return true
    if (visited.has(current)) continue
    visited.add(current)
    const currentNode = nodesById.get(current)
    if (currentNode === undefined) continue
    const after = workflowNodeField(currentNode, "after")
    if (Array.isArray(after)) {
      pending.push(...after.filter((value): value is string => typeof value === "string"))
    }
  }
  return false
}

export function nodeRegistrationField(type: WorkflowSourceNode["type"]): "agent" | "workflow" | "uses" {
  return type === "agent" ? "agent" : type === "workflow" ? "workflow" : "uses"
}
