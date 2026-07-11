import jsonata from "jsonata"

import type { JsonValue, YamlSourceOperation } from "@/api/types"
import {
  workflowNodeField,
  type WorkflowSourceNode,
} from "@/features/workflows/workflow-source-model"

export type WorkflowNodeReferenceKind =
  | "dependency"
  | "expression"
  | "artifact_source"

export type WorkflowNodeReferenceImpact = {
  readonly kind: WorkflowNodeReferenceKind
  readonly ownerNodeId: string
  readonly path: readonly (string | number)[]
  readonly occurrences: number
  readonly blocking: boolean
}

export type WorkflowNodeMutationPlan = {
  readonly operations: readonly YamlSourceOperation[]
  readonly impacts: readonly WorkflowNodeReferenceImpact[]
  readonly blockers: readonly string[]
}

type TokenRange = { readonly start: number; readonly end: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isExpressionObject(value: JsonValue): value is Record<string, JsonValue> & {
  readonly expression: string
} {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.expression === "string"
  )
}

function rawTokenRange(
  expression: string,
  name: string,
  end: number,
): TokenRange | undefined {
  const bareStart = end - name.length
  if (bareStart >= 0 && expression.slice(bareStart, end) === name) {
    return { start: bareStart, end }
  }
  if (expression[end - 1] !== "`") return undefined
  const opening = expression.lastIndexOf("`", end - 2)
  return opening >= 0 && expression.slice(opening + 1, end - 1) === name
    ? { start: opening, end }
    : undefined
}

function referenceTokenRanges(
  expression: string,
  nodeId: string,
): { readonly ranges: readonly TokenRange[]; readonly parseFailed: boolean } {
  let ast: unknown
  try {
    ast = jsonata(expression).ast()
  } catch {
    return { ranges: [], parseFailed: true }
  }

  const ranges = new Map<string, TokenRange>()
  const visited = new Set<object>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!isRecord(value) || visited.has(value)) return
    visited.add(value)

    if (value.type === "path" && Array.isArray(value.steps)) {
      const [root, steps, referenced] = value.steps
      if (
        isRecord(root) &&
        root.type === "variable" &&
        root.value === "" &&
        isRecord(steps) &&
        steps.type === "name" &&
        steps.value === "steps" &&
        isRecord(referenced) &&
        referenced.type === "name" &&
        referenced.value === nodeId &&
        typeof referenced.position === "number" &&
        Number.isSafeInteger(referenced.position)
      ) {
        const range = rawTokenRange(expression, nodeId, referenced.position)
        if (range !== undefined) ranges.set(`${range.start}:${range.end}`, range)
      }
    }

    Object.values(value).forEach(visit)
  }
  visit(ast)
  return {
    ranges: [...ranges.values()].sort((left, right) => left.start - right.start),
    parseFailed: false,
  }
}

function textualReference(expression: string, nodeId: string): boolean {
  const escaped = nodeId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  return (
    new RegExp(`\\$\\.steps\\.${escaped}(?![A-Za-z0-9_.-])`, "u").test(expression) ||
    expression.includes(`$.steps.\`${nodeId}\``)
  )
}

function jsonataNodeToken(nodeId: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(nodeId) ? nodeId : `\`${nodeId}\``
}

function rewriteExpression(
  expression: string,
  previousId: string,
  nextId: string,
):
  | { readonly kind: "none" }
  | { readonly kind: "blocked"; readonly occurrences: number }
  | { readonly kind: "rewritten"; readonly value: string; readonly occurrences: number } {
  const references = referenceTokenRanges(expression, previousId)
  if (references.parseFailed) {
    return textualReference(expression, previousId)
      ? { kind: "blocked", occurrences: 1 }
      : { kind: "none" }
  }
  if (references.ranges.length === 0) return { kind: "none" }
  const replacement = jsonataNodeToken(nextId)

  let rewritten = expression
  for (const range of [...references.ranges].sort((left, right) => right.start - left.start)) {
    rewritten = `${rewritten.slice(0, range.start)}${replacement}${rewritten.slice(range.end)}`
  }
  const verification = referenceTokenRanges(rewritten, nextId)
  if (
    verification.parseFailed ||
    verification.ranges.length !== references.ranges.length ||
    referenceTokenRanges(rewritten, previousId).ranges.length > 0
  ) {
    return { kind: "blocked", occurrences: references.ranges.length }
  }
  return {
    kind: "rewritten",
    value: rewritten,
    occurrences: references.ranges.length,
  }
}

function rewriteArtifactSource(
  expression: string,
  previousId: string,
  nextId: string,
):
  | { readonly kind: "none" }
  | { readonly kind: "blocked"; readonly occurrences: number }
  | { readonly kind: "rewritten"; readonly value: string; readonly occurrences: number } {
  const previous = `$.steps.${previousId}`
  if (expression === previous) {
    return {
      kind: "rewritten",
      value: `$.steps.${nextId}`,
      occurrences: 1,
    }
  }
  return textualReference(expression, previousId)
    ? { kind: "blocked", occurrences: 1 }
    : { kind: "none" }
}

function referenceKind(path: readonly (string | number)[]): WorkflowNodeReferenceKind {
  return path.length === 5 &&
    path[0] === "nodes" &&
    typeof path[1] === "number" &&
    path[2] === "artifacts" &&
    typeof path[3] === "number" &&
    path[4] === "source"
    ? "artifact_source"
    : "expression"
}

function visitExpressions(
  value: JsonValue,
  path: readonly (string | number)[],
  visit: (expression: string, path: readonly (string | number)[]) => void,
): void {
  if (isExpressionObject(value)) {
    visit(value.expression, [...path, "expression"])
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitExpressions(item, [...path, index], visit))
    return
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, nested]) =>
      visitExpressions(nested as JsonValue, [...path, key], visit),
    )
  }
}

function dependencyImpact(
  owner: WorkflowSourceNode,
  targetId: string,
  blocking: boolean,
): WorkflowNodeReferenceImpact | undefined {
  const after = workflowNodeField(owner, "after")
  if (!Array.isArray(after) || !after.includes(targetId)) return undefined
  return {
    kind: "dependency",
    ownerNodeId: owner.id,
    path: ["nodes", owner.index, "after"],
    occurrences: after.filter((value) => value === targetId).length,
    blocking,
  }
}

export function planWorkflowNodeRename(
  nodes: readonly WorkflowSourceNode[],
  renamed: WorkflowSourceNode,
  nextId: string,
): WorkflowNodeMutationPlan {
  const operations: YamlSourceOperation[] = [
    { op: "set", path: ["nodes", renamed.index, "id"], value: nextId },
  ]
  const impacts: WorkflowNodeReferenceImpact[] = []
  const blockers: string[] = []

  for (const node of nodes) {
    const dependency = dependencyImpact(node, renamed.id, false)
    if (dependency !== undefined) {
      impacts.push(dependency)
      const after = workflowNodeField(node, "after")
      operations.push({
        op: "set",
        path: [...dependency.path],
        value: Array.isArray(after)
          ? after.map((value) => value === renamed.id ? nextId : value)
          : [],
      })
    }

    visitExpressions(node.value, ["nodes", node.index], (expression, path) => {
      const kind = referenceKind(path.slice(0, -1))
      const rewrite = kind === "artifact_source"
        ? rewriteArtifactSource(expression, renamed.id, nextId)
        : rewriteExpression(expression, renamed.id, nextId)
      if (rewrite.kind === "none") return
      const blocking = rewrite.kind === "blocked"
      impacts.push({
        kind,
        ownerNodeId: node.id,
        path,
        occurrences: rewrite.occurrences,
        blocking,
      })
      if (blocking) {
        blockers.push(
          `A expression em ${path.join(".")} não pode ser reescrita com segurança para ${nextId}.`,
        )
      } else {
        operations.push({ op: "set", path: [...path], value: rewrite.value })
      }
    })
  }

  return {
    operations: blockers.length === 0 ? operations : [],
    impacts,
    blockers,
  }
}

export function planWorkflowNodeDelete(
  nodes: readonly WorkflowSourceNode[],
  removed: WorkflowSourceNode,
): WorkflowNodeMutationPlan {
  const impacts: WorkflowNodeReferenceImpact[] = []
  const blockers: string[] = []

  for (const node of nodes) {
    const dependency = dependencyImpact(node, removed.id, node.index !== removed.index)
    if (dependency !== undefined) {
      impacts.push(dependency)
      if (dependency.blocking) {
        blockers.push(`Remova primeiro a dependência after de ${node.id}.`)
      }
    }
    visitExpressions(node.value, ["nodes", node.index], (expression, path) => {
      const kind = referenceKind(path.slice(0, -1))
      const references = kind === "artifact_source"
        ? {
            ranges: expression === `$.steps.${removed.id}` ? [{ start: 0, end: expression.length }] : [],
            parseFailed: expression !== `$.steps.${removed.id}` && textualReference(expression, removed.id),
          }
        : referenceTokenRanges(expression, removed.id)
      const parseBlocked = references.parseFailed && textualReference(expression, removed.id)
      if (references.ranges.length === 0 && !parseBlocked) return
      const blocking = node.index !== removed.index
      impacts.push({
        kind,
        ownerNodeId: node.id,
        path,
        occurrences: Math.max(1, references.ranges.length),
        blocking,
      })
      if (blocking) {
        blockers.push(`Remova primeiro a referência de expression em ${path.join(".")}.`)
      }
    })
  }

  return {
    operations: blockers.length === 0
      ? [{ op: "sequence_remove", path: ["nodes"], index: removed.index }]
      : [],
    impacts,
    blockers,
  }
}
