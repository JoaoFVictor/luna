import type { JsonValue, YamlSourceOperation } from "@/api/types"

export type WorkflowOperationHistoryEntry = {
  readonly forward: readonly YamlSourceOperation[]
  readonly backward: readonly YamlSourceOperation[]
}

type LocatedValue =
  | { readonly exists: true; readonly value: JsonValue }
  | { readonly exists: false }

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function locate(root: JsonValue, path: readonly (string | number)[]): LocatedValue {
  let current = root
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) return { exists: false }
      const next = current[segment]
      if (next === undefined) return { exists: false }
      current = next
      continue
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return { exists: false }
    const next = current[segment]
    if (next === undefined) return { exists: false }
    current = next
  }
  return { exists: true, value: current }
}

function replaceAt(
  root: JsonValue,
  path: readonly (string | number)[],
  value: JsonValue | undefined,
): JsonValue | undefined {
  const [head, ...tail] = path
  if (head === undefined) return value
  if (typeof head === "number") {
    if (!Array.isArray(root) || head >= root.length) return undefined
    const current = root[head]
    if (current === undefined) return undefined
    const next = replaceAt(current, tail, value)
    if (tail.length > 0 && next === undefined) return undefined
    const copy = [...root]
    if (tail.length === 0 && value === undefined) copy.splice(head, 1)
    else copy[head] = next as JsonValue
    return copy
  }
  if (!isRecord(root)) return undefined
  if (tail.length > 0 && !Object.hasOwn(root, head)) return undefined
  if (tail.length === 0) {
    const copy = { ...root }
    if (value === undefined) delete copy[head]
    else copy[head] = value
    return copy
  }
  const current = root[head]
  if (current === undefined) return undefined
  const next = replaceAt(current, tail, value)
  if (next === undefined) return undefined
  return { ...root, [head]: next }
}

function applyOperation(
  root: JsonValue,
  operation: YamlSourceOperation,
): JsonValue | undefined {
  if (operation.op === "set") return replaceAt(root, operation.path, operation.value)
  if (operation.op === "delete") return replaceAt(root, operation.path, undefined)
  const target = locate(root, operation.path)
  if (!target.exists || !Array.isArray(target.value)) return undefined
  const next = [...target.value]
  if (operation.op === "sequence_insert") {
    const index = operation.index ?? next.length
    if (index > next.length) return undefined
    next.splice(index, 0, operation.value)
  } else {
    if (operation.index >= next.length) return undefined
    next.splice(operation.index, 1)
  }
  return replaceAt(root, operation.path, next)
}

export function workflowOperationHistoryEntry(
  source: JsonValue,
  operations: readonly YamlSourceOperation[],
): WorkflowOperationHistoryEntry | undefined {
  let current = source
  const backward: YamlSourceOperation[] = []
  for (const operation of operations) {
    const previous = locate(current, operation.path)
    let inverse: YamlSourceOperation | undefined
    if (operation.op === "set") {
      inverse = previous.exists
        ? { op: "set", path: operation.path, value: previous.value }
        : { op: "delete", path: operation.path }
    } else if (operation.op === "delete") {
      if (!previous.exists) return undefined
      inverse = { op: "set", path: operation.path, value: previous.value }
    } else if (operation.op === "sequence_insert") {
      if (!previous.exists || !Array.isArray(previous.value)) return undefined
      inverse = {
        op: "sequence_remove",
        path: operation.path,
        index: operation.index ?? previous.value.length,
      }
    } else {
      if (
        !previous.exists ||
        !Array.isArray(previous.value) ||
        operation.index >= previous.value.length
      ) return undefined
      inverse = {
        op: "sequence_insert",
        path: operation.path,
        index: operation.index,
        value: previous.value[operation.index]!,
      }
    }
    const next = applyOperation(current, operation)
    if (next === undefined) return undefined
    current = next
    backward.unshift(inverse)
  }
  return { forward: [...operations], backward }
}
