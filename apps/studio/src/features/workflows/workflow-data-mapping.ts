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
  return workflowSchemaFields(schema).map((field) => workflowFieldPathLabel(field.path))
}

export type WorkflowSchemaField = {
  readonly path: readonly string[]
  readonly valueType: string
  readonly defaultValue?: JsonValue
}

const JSONATA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u
const JSONATA_IDENTIFIER_AT = /[A-Za-z_][A-Za-z0-9_]*/uy

function workflowBracketPathSegment(
  expression: string,
  start: number,
): { readonly segment: string; readonly end: number } | undefined {
  if (expression[start] !== "[" || expression[start + 1] !== '"') return undefined
  let cursor = start + 2
  let escaped = false
  while (cursor < expression.length) {
    const character = expression[cursor]
    if (!escaped && character === '"') break
    escaped = !escaped && character === "\\"
    if (character !== "\\") escaped = false
    cursor += 1
  }
  if (expression[cursor] !== '"' || expression[cursor + 1] !== "]") return undefined
  try {
    const segment = JSON.parse(expression.slice(start + 1, cursor + 1))
    return typeof segment === "string" ? { segment, end: cursor + 2 } : undefined
  } catch {
    return undefined
  }
}

export function workflowFieldPathLabel(path: readonly string[]): string {
  return path.reduce(
    (label, segment) => JSONATA_IDENTIFIER.test(segment)
      ? `${label}${label.length === 0 ? "" : "."}${segment}`
      : `${label}[${JSON.stringify(segment)}]`,
    "",
  )
}

export function workflowStepFieldExpression(
  nodeId: string,
  path: readonly string[] = [],
): string {
  return [nodeId, ...path].reduce(
    (expression, segment) => JSONATA_IDENTIFIER.test(segment)
      ? `${expression}.${segment}`
      : `${expression}[${JSON.stringify(segment)}]`,
    "$.steps",
  )
}

/** Inverse of workflowStepFieldExpression for its exact, non-computed grammar. */
export function workflowStepFieldReference(
  expression: string,
): { readonly nodeId: string; readonly path: readonly string[] } | undefined {
  const root = "$.steps"
  if (!expression.startsWith(root)) return undefined
  const segments: string[] = []
  let cursor = root.length
  while (cursor < expression.length) {
    if (expression[cursor] === ".") {
      JSONATA_IDENTIFIER_AT.lastIndex = cursor + 1
      const match = JSONATA_IDENTIFIER_AT.exec(expression)
      if (match === null) return undefined
      segments.push(match[0])
      cursor = JSONATA_IDENTIFIER_AT.lastIndex
      continue
    }
    const bracket = workflowBracketPathSegment(expression, cursor)
    if (bracket === undefined) return undefined
    segments.push(bracket.segment)
    cursor = bracket.end
  }
  const [nodeId, ...path] = segments
  return nodeId === undefined || nodeId.length === 0 ? undefined : { nodeId, path }
}

export function workflowInputPathValue(
  inputs: Readonly<Record<string, JsonValue>>,
  path: readonly string[],
): JsonValue | undefined {
  let value: JsonValue | undefined = inputs
  for (const segment of path) {
    if (!isRecord(value) || !Object.hasOwn(value, segment)) return undefined
    value = value[segment]
  }
  return value
}

export function workflowInputPathExists(
  inputs: Readonly<Record<string, JsonValue>>,
  path: readonly string[],
): boolean {
  return workflowInputPathValue(inputs, path) !== undefined
}

export function workflowSetInputPath(
  inputs: Readonly<Record<string, JsonValue>>,
  path: readonly string[],
  value: JsonValue,
): Record<string, JsonValue> {
  const [head, ...tail] = path
  if (head === undefined) return { ...inputs }
  if (tail.length === 0) return { ...inputs, [head]: value }
  const child = isRecord(inputs[head]) ? inputs[head] : {}
  return {
    ...inputs,
    [head]: workflowSetInputPath(child, tail, value),
  }
}

export function workflowRemoveInputPath(
  inputs: Readonly<Record<string, JsonValue>>,
  path: readonly string[],
): Record<string, JsonValue> {
  const [head, ...tail] = path
  if (head === undefined || !Object.hasOwn(inputs, head)) return { ...inputs }
  const result = { ...inputs }
  if (tail.length === 0) {
    Reflect.deleteProperty(result, head)
    return result
  }
  const child = inputs[head]
  if (!isRecord(child)) return result
  const nextChild = workflowRemoveInputPath(child, tail)
  if (Object.keys(nextChild).length === 0) Reflect.deleteProperty(result, head)
  else result[head] = nextChild
  return result
}

export function workflowSchemaFieldDefault(field: WorkflowSchemaField): JsonValue {
  if (field.defaultValue !== undefined) return field.defaultValue
  if (field.valueType === "string") return ""
  if (field.valueType === "integer" || field.valueType === "number") return 0
  if (field.valueType === "boolean") return false
  if (field.valueType === "array") return []
  if (field.valueType === "object") return {}
  return null
}

export function workflowSchemaFields(
  schema: JsonValue | undefined,
  prefix: readonly string[] = [],
): WorkflowSchemaField[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return []
  return Object.entries(schema.properties).flatMap(([name, property]) => {
    if (!isRecord(property)) return []
    const path = [...prefix, name]
    const valueType = typeof property.type === "string" ? property.type : "unknown"
    const defaultValue = property.default !== undefined
      ? property.default
      : (valueType === "integer" || valueType === "number") && typeof property.minimum === "number"
        ? property.minimum
        : undefined
    return [
      { path, valueType, ...(defaultValue === undefined ? {} : { defaultValue }) },
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
