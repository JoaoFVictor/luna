import type {
  JsonValue,
  YamlSourceOperation,
} from "@/api/types"

export type WorkflowSourceNode = {
  index: number
  id: string
  type: "built_in" | "agent" | "pattern" | "human_gate"
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

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nodeType(value: JsonValue | undefined): WorkflowSourceNode["type"] | undefined {
  return value === "built_in" || value === "agent" || value === "pattern" || value === "human_gate"
    ? value
    : undefined
}

export function workflowSourceNodes(source: JsonValue): WorkflowSourceNode[] {
  if (!isRecord(source) || !Array.isArray(source.nodes)) return []
  return source.nodes.flatMap((value, index) => {
    if (!isRecord(value) || typeof value.id !== "string") return []
    const type = nodeType(value.type)
    const registrationId = type === "agent" ? value.agent : value.uses
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
      : type === undefined
        ? value?.agent ?? value?.uses
        : value?.uses
    const node = nodesByIndex.get(index)
    const problems: string[] = []
    if (value === undefined) problems.push("O node deve ser um mapping YAML.")
    if (id === undefined) problems.push("O node precisa de um id não vazio.")
    if (type === undefined) problems.push("O node precisa de um type reconhecido.")
    if (typeof registration !== "string" || registration.length === 0) {
      problems.push(type === "agent" ? "O node precisa de agent." : "O node precisa de uses.")
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

export function nodeRegistrationField(type: WorkflowSourceNode["type"]): "agent" | "uses" {
  return type === "agent" ? "agent" : "uses"
}
