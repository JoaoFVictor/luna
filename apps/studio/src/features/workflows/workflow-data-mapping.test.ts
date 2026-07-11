import { describe, expect, it } from "vitest"

import {
  workflowAvailableInputNodes,
  workflowInputSchemaFields,
  workflowSchemaFields,
  workflowSchemaTypesCompatible,
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
      { path: "result", valueType: "object" },
      { path: "result.score", valueType: "integer" },
    ])
    expect(workflowSchemaTypesCompatible("number", "integer")).toBe(true)
    expect(workflowSchemaTypesCompatible("string", "integer")).toBe(false)
  })
})
