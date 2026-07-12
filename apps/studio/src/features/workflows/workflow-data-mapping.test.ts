import { describe, expect, it } from "vitest"

import {
  workflowAvailableInputNodes,
  workflowInputSchemaFields,
  workflowFieldPathLabel,
  workflowInputPathValue,
  workflowRemoveInputPath,
  workflowSchemaFields,
  workflowSchemaTypesCompatible,
  workflowSetInputPath,
  workflowStepFieldExpression,
  workflowStepFieldReference,
} from "@/features/workflows/workflow-data-mapping"
import { workflowSourceNodes } from "@/features/workflows/workflow-source-model"

describe("workflow data mapping", () => {
  it("offers only transitive upstream nodes as data sources", () => {
    const nodes = workflowSourceNodes({ nodes: [
      { id: "trigger", type: "built_in", uses: "runtime.preflight" },
      { id: "context", type: "built_in", uses: "context.collect_context", after: ["trigger"] },
      { id: "review", type: "agent", agent: "reviewer", after: ["context"] },
      { id: "unrelated", type: "agent", agent: "other" },
    ] })
    expect(workflowAvailableInputNodes(nodes[2]!, nodes).map((node) => node.id)).toEqual([
      "trigger",
      "context",
    ])
  })

  it("derives safe initial values from schema defaults and numeric minimums", () => {
    expect(workflowSchemaFields({
      type: "object",
      properties: {
        title: { type: "string", default: "Relatório" },
        timeout_ms: { type: "integer", minimum: 1 },
      },
    })).toEqual([
      { path: ["title"], valueType: "string", defaultValue: "Relatório" },
      { path: ["timeout_ms"], valueType: "integer", defaultValue: 1 },
    ])
  })

  it("projects schema properties into suggested input fields", () => {
    expect(workflowInputSchemaFields({
      type: "object",
      properties: { context: { type: "object" }, strict: { type: "boolean" } },
    })).toEqual(["context", "strict"])
  })

  it("projects nested typed ports and checks safe numeric compatibility", () => {
    expect(workflowSchemaFields({
      type: "object",
      properties: {
        result: {
          type: "object",
          properties: { score: { type: "integer" } },
        },
      },
    })).toEqual([
      { path: ["result"], valueType: "object" },
      { path: ["result", "score"], valueType: "integer" },
    ])
    expect(workflowSchemaTypesCompatible("number", "integer")).toBe(true)
    expect(workflowSchemaTypesCompatible("string", "integer")).toBe(false)
  })

  it("builds canonical JSONata without confusing literal dots with nesting", () => {
    expect(workflowStepFieldExpression("agent-one", ["result value", "literal.dot"]))
      .toBe('$.steps["agent-one"]["result value"]["literal.dot"]')
    expect(workflowStepFieldExpression('agent"quote', ['field"quote']))
      .toBe('$.steps["agent\\\"quote"]["field\\\"quote"]')
    expect(workflowStepFieldExpression("agent", ["result", "score"]))
      .toBe("$.steps.agent.result.score")
    expect(workflowFieldPathLabel(["literal.dot"])).toBe('["literal.dot"]')
  })

  it("parses only exact references emitted by the canonical expression builder", () => {
    expect(workflowStepFieldReference("$.steps.collect.result.score")).toEqual({
      nodeId: "collect",
      path: ["result", "score"],
    })
    expect(workflowStepFieldReference('$.steps["collect-data"]["result value"]')).toEqual({
      nodeId: "collect-data",
      path: ["result value"],
    })
    expect(workflowStepFieldReference("$sum($.steps.collect.score)")).toBeUndefined()
    expect(workflowStepFieldReference("$.steps.collect.score + 1")).toBeUndefined()
    expect(workflowStepFieldReference("$.invocation.issue")).toBeUndefined()
  })

  it("sets, reads, and removes nested paths without mutating dotted properties", () => {
    const original = { "config.value": "literal" }
    const nested = workflowSetInputPath(original, ["config", "value"], 2)
    expect(nested).toEqual({
      "config.value": "literal",
      config: { value: 2 },
    })
    expect(workflowInputPathValue(nested, ["config", "value"])).toBe(2)
    expect(workflowInputPathValue(nested, ["config.value"])).toBe("literal")
    expect(workflowRemoveInputPath(nested, ["config", "value"]))
      .toEqual({ "config.value": "literal" })
  })
})
