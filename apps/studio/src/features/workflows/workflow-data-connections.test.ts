import { describe, expect, it } from "vitest"

import {
  workflowDataConnections,
  workflowDataPathLabel,
} from "@/features/workflows/workflow-data-connections"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

function node(id: string, input?: WorkflowSourceNode["value"]["input"]): WorkflowSourceNode {
  return {
    index: 0,
    id,
    type: "built_in",
    registrationId: `capability.${id}`,
    value: { id, type: "built_in", uses: `capability.${id}`, ...(input === undefined ? {} : { input }) },
  }
}

describe("workflow data connections", () => {
  it("projects nested canonical input mappings separately from after dependencies", () => {
    const connections = workflowDataConnections([
      node("collect"),
      node("normalize"),
      node("publish", {
        title: { expression: "$.steps.collect.title" },
        nested: {
          score: { expression: "$.steps.collect.result.score" },
          owner: { expression: "$.steps.normalize.owner" },
        },
        items: [{ expression: "$.steps.collect.items" }],
        advanced: { expression: "$sum($.steps.collect.values)" },
      }),
    ])

    expect(connections).toEqual([
      {
        sourceId: "collect",
        targetId: "publish",
        mappings: [
          { expression: "$.steps.collect.title", sourcePath: ["title"], targetPath: ["title"] },
          { expression: "$.steps.collect.result.score", sourcePath: ["result", "score"], targetPath: ["nested", "score"] },
          { expression: "$.steps.collect.items", sourcePath: ["items"], targetPath: ["items", 0] },
        ],
      },
      {
        sourceId: "normalize",
        targetId: "publish",
        mappings: [
          { expression: "$.steps.normalize.owner", sourcePath: ["owner"], targetPath: ["nested", "owner"] },
        ],
      },
    ])
  })

  it("does not invent a connection for a missing source node", () => {
    expect(workflowDataConnections([
      node("publish", { value: { expression: "$.steps.missing.value" } }),
    ])).toEqual([])
  })

  it("formats source and destination paths for accessible descriptions", () => {
    expect(workflowDataPathLabel(["result", "review score", 0])).toBe('result["review score"][0]')
    expect(workflowDataPathLabel([])).toBe("valor completo")
  })
})
