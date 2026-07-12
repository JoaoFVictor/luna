import type { DraftValidationResult } from "@/api/types"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

export type WorkflowNodeDiagnostic = {
  readonly severity: "error" | "warning"
  readonly code: string
  readonly message: string
  readonly fieldPath?: readonly (string | number)[]
}

export type WorkflowInspectorField =
  | "registration"
  | "identity"
  | "worker"
  | "dependencies"
  | "input"
  | "advanced"

export type WorkflowInspectorSection = "summary" | "inputs" | "advanced"

export function workflowInspectorField(
  fieldPath: readonly (string | number)[] | undefined,
): WorkflowInspectorField | undefined {
  const root = fieldPath?.[0]
  if (typeof root !== "string") return undefined
  if (root === "uses" || root === "agent" || root === "workflow" || root === "output_schema") return "registration"
  if (root === "id" || root === "type") return "identity"
  if (root === "worker") return "worker"
  if (root === "after") return "dependencies"
  if (root === "input") return "input"
  return "advanced"
}

export function workflowInspectorSection(
  fieldPath: readonly (string | number)[] | undefined,
): WorkflowInspectorSection {
  const field = workflowInspectorField(fieldPath)
  if (field === "dependencies" || field === "input") return "inputs"
  if (field === "identity" || field === "worker" || field === "advanced") return "advanced"
  return "summary"
}

export function workflowInspectorFieldDiagnostics(
  diagnostics: readonly WorkflowNodeDiagnostic[],
  field: WorkflowInspectorField,
): readonly WorkflowNodeDiagnostic[] {
  return diagnostics.filter(
    (diagnostic) => workflowInspectorField(diagnostic.fieldPath) === field,
  )
}

export function workflowNodeFallbackDiagnostics(
  diagnostics: readonly WorkflowNodeDiagnostic[],
): readonly WorkflowNodeDiagnostic[] {
  return diagnostics.filter(
    (diagnostic) => workflowInspectorField(diagnostic.fieldPath) === undefined,
  )
}

export function workflowNodeDiagnostics(
  nodes: readonly WorkflowSourceNode[],
  diagnostics: DraftValidationResult["diagnostics"],
): ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]> {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const result = new Map<string, WorkflowNodeDiagnostic[]>()
  for (const diagnostic of diagnostics) {
    if (diagnostic.node_id === undefined || !nodeIds.has(diagnostic.node_id)) continue
    result.set(diagnostic.node_id, [
      ...(result.get(diagnostic.node_id) ?? []),
      {
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.node_field_path === undefined
          ? {}
          : { fieldPath: diagnostic.node_field_path }),
      },
    ])
  }
  return result
}

export function workflowEdgeDiagnostics(
  diagnostics: DraftValidationResult["diagnostics"],
): ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]> {
  const result = new Map<string, WorkflowNodeDiagnostic[]>()
  for (const diagnostic of diagnostics) {
    if (diagnostic.edge === undefined) continue
    const key = `${diagnostic.edge.from}\u0000${diagnostic.edge.to}`
    result.set(key, [
      ...(result.get(key) ?? []),
      { severity: diagnostic.severity, code: diagnostic.code, message: diagnostic.message },
    ])
  }
  return result
}
