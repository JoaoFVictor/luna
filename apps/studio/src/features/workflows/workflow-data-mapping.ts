import type { JsonValue } from "@/api/types"
import {
  workflowNodeField,
  type WorkflowSourceNode,
} from "@/features/workflows/workflow-source-model"

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function workflowAvailableInputNodes(
  selected: WorkflowSourceNode,
  nodes: readonly WorkflowSourceNode[],
): WorkflowSourceNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const available = new Set<string>()
  const pending = workflowNodeField(selected, "after")
  const queue = Array.isArray(pending)
    ? pending.filter((value): value is string => typeof value === "string")
    : []
  while (queue.length > 0) {
    const id = queue.pop()
    if (id === undefined || available.has(id)) continue
    const node = byId.get(id)
    if (node === undefined) continue
    available.add(id)
    const dependencies = workflowNodeField(node, "after")
    if (Array.isArray(dependencies)) {
      queue.push(...dependencies.filter((value): value is string => typeof value === "string"))
    }
  }
  return nodes.filter((node) => available.has(node.id))
}

export function workflowInputSchemaFields(schema: JsonValue | undefined): string[] {
  return workflowSchemaFields(schema).map((field) => field.path)
}

export type WorkflowSchemaField = {
  readonly path: string
  readonly valueType: string
}

export function workflowSchemaFields(
  schema: JsonValue | undefined,
  prefix = "",
): WorkflowSchemaField[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return []
  return Object.entries(schema.properties).flatMap(([name, property]) => {
    if (!isRecord(property)) return []
    const path = prefix === "" ? name : `${prefix}.${name}`
    const valueType = typeof property.type === "string" ? property.type : "unknown"
    return [
      { path, valueType },
      ...(valueType === "object" ? workflowSchemaFields(property, path) : []),
    ]
  })
}

export function workflowSchemaTypesCompatible(
  expected: string | undefined,
  available: string | undefined,
): boolean {
  if (expected === undefined || available === undefined) return true
  if (expected === "unknown" || available === "unknown") return true
  return expected === available || (expected === "number" && available === "integer")
}
