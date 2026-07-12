import { describe, expect, it } from "vitest"

import type { JsonValue } from "@/api/types"
import {
  planWorkflowNodeDelete,
  planWorkflowNodeRename,
} from "@/features/workflows/workflow-node-refactor"
import { workflowSourceNodes } from "@/features/workflows/workflow-source-model"

const source: JsonValue = {
  nodes: [
    {
      id: "first",
      type: "built_in",
      uses: "runtime.preflight",
      artifacts: [{
        path: "first.json",
        publisher: "artifacts.run",
        source: { expression: "$.steps.first" },
      }],
    },
    {
      id: "consumer",
      type: "agent",
      agent: "reviewer",
      output_schema: "output.schema.json",
      after: ["first"],
      input: {
        value: {
          expression: "$append($.steps.first.value, \"$.steps.first is literal\")",
        },
      },
    },
  ],
}

describe("workflow node refactor planning", () => {
  it("plans one atomic rename across dependencies, expressions, and artifact sources", () => {
    const nodes = workflowSourceNodes(source)
    const plan = planWorkflowNodeRename(nodes, nodes[0]!, "bootstrap")

    expect(plan.blockers).toEqual([])
    expect(plan.impacts).toEqual([
      {
        kind: "artifact_source",
        ownerNodeId: "first",
        path: ["nodes", 0, "artifacts", 0, "source", "expression"],
        occurrences: 1,
        blocking: false,
      },
      {
        kind: "dependency",
        ownerNodeId: "consumer",
        path: ["nodes", 1, "after"],
        occurrences: 1,
        blocking: false,
      },
      {
        kind: "expression",
        ownerNodeId: "consumer",
        path: ["nodes", 1, "input", "value", "expression"],
        occurrences: 1,
        blocking: false,
      },
    ])
    expect(plan.operations).toEqual([
      { op: "set", path: ["nodes", 0, "id"], value: "bootstrap" },
      {
        op: "set",
        path: ["nodes", 0, "artifacts", 0, "source", "expression"],
        value: "$.steps.bootstrap",
      },
      { op: "set", path: ["nodes", 1, "after"], value: ["bootstrap"] },
      {
        op: "set",
        path: ["nodes", 1, "input", "value", "expression"],
        value: "$append($.steps.bootstrap.value, \"$.steps.first is literal\")",
      },
    ])
  })

  it("uses JSONata quoted names while keeping artifact sources in their canonical syntax", () => {
    const nodes = workflowSourceNodes(source)
    const plan = planWorkflowNodeRename(nodes, nodes[0]!, "new-id")
    expect(plan.blockers).toEqual([])
    expect(plan.operations).toEqual([
      { op: "set", path: ["nodes", 0, "id"], value: "new-id" },
      {
        op: "set",
        path: ["nodes", 0, "artifacts", 0, "source", "expression"],
        value: "$.steps.new-id",
      },
      { op: "set", path: ["nodes", 1, "after"], value: ["new-id"] },
      {
        op: "set",
        path: ["nodes", 1, "input", "value", "expression"],
        value: "$append($.steps.`new-id`.value, \"$.steps.first is literal\")",
      },
    ])
  })

  it("renames an existing non-bare id in both artifact and JSONata references", () => {
    const nonBare: JsonValue = {
      nodes: [
        {
          id: "first-step",
          type: "built_in",
          uses: "runtime.preflight",
          artifacts: [{
            path: "first.json",
            publisher: "artifacts.run",
            source: { expression: "$.steps.first-step" },
          }],
        },
        {
          id: "consumer",
          type: "built_in",
          uses: "runtime.preflight",
          input: { value: { expression: "$.steps.`first-step`.value" } },
        },
      ],
    }
    const nodes = workflowSourceNodes(nonBare)
    const plan = planWorkflowNodeRename(nodes, nodes[0]!, "bootstrap")

    expect(plan.blockers).toEqual([])
    expect(plan.operations).toContainEqual({
      op: "set",
      path: ["nodes", 0, "artifacts", 0, "source", "expression"],
      value: "$.steps.bootstrap",
    })
    expect(plan.operations).toContainEqual({
      op: "set",
      path: ["nodes", 1, "input", "value", "expression"],
      value: "$.steps.bootstrap.value",
    })
  })

  it("does not reinterpret a JSONata string literal as a workflow reference", () => {
    const literalOnly: JsonValue = {
      nodes: [
        { id: "first", type: "built_in", uses: "runtime.preflight" },
        {
          id: "consumer",
          type: "built_in",
          uses: "runtime.preflight",
          input: { value: { expression: "\"$.steps.first\"" } },
        },
      ],
    }
    const nodes = workflowSourceNodes(literalOnly)
    const plan = planWorkflowNodeRename(nodes, nodes[0]!, "renamed")
    expect(plan.blockers).toEqual([])
    expect(plan.impacts).toEqual([])
    expect(plan.operations).toEqual([
      { op: "set", path: ["nodes", 0, "id"], value: "renamed" },
    ])
  })

  it("blocks delete until every incoming semantic reference is resolved", () => {
    const nodes = workflowSourceNodes(source)
    const blocked = planWorkflowNodeDelete(nodes, nodes[0]!)
    expect(blocked.operations).toEqual([])
    expect(blocked.blockers).toEqual([
      "Remova primeiro a dependência after de consumer.",
      "Remova primeiro a referência de expression em nodes.1.input.value.expression.",
    ])
    expect(blocked.impacts).toHaveLength(3)

    const isolated: JsonValue = {
      nodes: [{
        id: "first",
        type: "built_in",
        uses: "runtime.preflight",
        artifacts: [{
          path: "first.json",
          publisher: "artifacts.run",
          source: { expression: "$.steps.first" },
        }],
      }],
    }
    const isolatedNodes = workflowSourceNodes(isolated)
    expect(planWorkflowNodeDelete(isolatedNodes, isolatedNodes[0]!)).toMatchObject({
      operations: [{ op: "sequence_remove", path: ["nodes"], index: 0 }],
      blockers: [],
    })
  })

  it("blocks an invalid expression containing a textual step reference", () => {
    const invalid: JsonValue = {
      nodes: [
        { id: "first", type: "built_in", uses: "runtime.preflight" },
        {
          id: "consumer",
          type: "built_in",
          uses: "runtime.preflight",
          input: { value: { expression: "($.steps.first" } },
        },
      ],
    }
    const nodes = workflowSourceNodes(invalid)
    expect(planWorkflowNodeRename(nodes, nodes[0]!, "renamed").operations).toEqual([])
  })

  it("blocks a malformed expression containing a quoted non-bare step reference", () => {
    const invalid: JsonValue = {
      nodes: [
        { id: "first-step", type: "built_in", uses: "runtime.preflight" },
        {
          id: "consumer",
          type: "built_in",
          uses: "runtime.preflight",
          input: { value: { expression: "($.steps.`first-step`" } },
        },
      ],
    }
    const nodes = workflowSourceNodes(invalid)
    expect(planWorkflowNodeRename(nodes, nodes[0]!, "renamed").operations).toEqual([])
  })
})
