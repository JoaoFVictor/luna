import type { JsonValue } from "@/api/types"
import { workflowStepFieldReference } from "@/features/workflows/workflow-data-mapping"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

export type WorkflowDataMapping = {
  readonly expression: string
  readonly sourcePath: readonly string[]
  readonly targetPath: readonly (string | number)[]
}

export type WorkflowDataConnection = {
  readonly sourceId: string
  readonly targetId: string
  readonly mappings: readonly WorkflowDataMapping[]
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function expressionMappings(
  value: JsonValue,
  targetPath: readonly (string | number)[],
): Array<{
  readonly sourceId: string
  readonly mapping: WorkflowDataMapping
}> {
  if (isRecord(value) && typeof value.expression === "string") {
    const parsed = workflowStepFieldReference(value.expression)
    return parsed === undefined ? [] : [{
      sourceId: parsed.nodeId,
      mapping: {
        expression: value.expression,
        sourcePath: parsed.path,
        targetPath,
      },
    }]
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => expressionMappings(item, [...targetPath, index]))
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, item]) =>
      expressionMappings(item, [...targetPath, key]),
    )
  }
  return []
}

export function workflowDataConnections(
  nodes: readonly WorkflowSourceNode[],
): WorkflowDataConnection[] {
  const knownIds = new Set(nodes.map((node) => node.id))
  const connections = new Map<string, {
    sourceId: string
    targetId: string
    mappings: WorkflowDataMapping[]
  }>()
  for (const target of nodes) {
    const input = target.value.input
    if (input === undefined) continue
    for (const { sourceId, mapping } of expressionMappings(input, [])) {
      if (!knownIds.has(sourceId)) continue
      const key = `${sourceId}\u0000${target.id}`
      const connection = connections.get(key) ?? {
        sourceId,
        targetId: target.id,
        mappings: [],
      }
      connection.mappings.push(mapping)
      connections.set(key, connection)
    }
  }
  return [...connections.values()]
}

export function workflowDataPathLabel(path: readonly (string | number)[]): string {
  if (path.length === 0) return "valor completo"
  return path.reduce<string>((label, segment) => {
    if (typeof segment === "number") return `${label}[${segment}]`
    if (IDENTIFIER.test(segment)) return `${label}${label.length === 0 ? "" : "."}${segment}`
    return `${label}[${JSON.stringify(segment)}]`
  }, "")
}
