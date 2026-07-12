import { describe, expect, it } from "vitest"

import type { DraftValidationResult } from "@/api/types"
import {
  workflowInspectorField,
  workflowNodeDiagnostics,
} from "@/features/workflows/workflow-node-diagnostics"
import { workflowSourceNodes } from "@/features/workflows/workflow-source-model"

describe("workflow node diagnostics", () => {
  it("projects authoritative field diagnostics onto their visual node", () => {
    const nodes = workflowSourceNodes({ nodes: [
      { id: "context", type: "built_in", uses: "context.collect_context" },
    ] })
    const diagnostics = [{
      severity: "error" as const,
      code: "invalid-input",
      message: "Input is missing",
      resource: { kind: "workflow" as const, id: "review" },
      field_path: "$.nodes[99].input",
      node_id: "context",
      node_field_path: ["input"],
    }] satisfies DraftValidationResult["diagnostics"]

    expect(workflowNodeDiagnostics(nodes, diagnostics).get("context")).toEqual([
      {
        severity: "error",
        code: "invalid-input",
        message: "Input is missing",
        fieldPath: ["input"],
      },
    ])
  })

  it("never infers node ownership from a numeric JSONPath index", () => {
    const nodes = workflowSourceNodes({ nodes: [
      { id: "context", type: "built_in", uses: "context.collect_context" },
    ] })
    const diagnostics = [{
      severity: "error" as const,
      code: "invalid-input",
      message: "Input is missing",
      resource: { kind: "workflow" as const, id: "review" },
      field_path: "$.nodes[0].input",
    }] satisfies DraftValidationResult["diagnostics"]

    expect(workflowNodeDiagnostics(nodes, diagnostics).size).toBe(0)
  })

  it("routes relative paths to stable inspector fields", () => {
    expect(workflowInspectorField(["input", "prompt"])).toBe("input")
    expect(workflowInspectorField(["after", 0])).toBe("dependencies")
    expect(workflowInspectorField(["agent"])).toBe("registration")
    expect(workflowInspectorField(undefined)).toBeUndefined()
  })

  it("leaves resource-level diagnostics in the global problems surface", () => {
    const nodes = workflowSourceNodes({ nodes: [
      { id: "context", type: "built_in", uses: "context.collect_context" },
    ] })
    const diagnostics = [{
      severity: "warning" as const,
      code: "workflow-warning",
      message: "Review the workflow",
      resource: { kind: "workflow" as const, id: "review" },
    }] satisfies DraftValidationResult["diagnostics"]

    expect(workflowNodeDiagnostics(nodes, diagnostics).size).toBe(0)
  })
})
