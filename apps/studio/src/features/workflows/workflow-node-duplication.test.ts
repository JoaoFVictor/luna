import { describe, expect, it } from "vitest"

import { duplicateWorkflowNodeOperations } from "@/features/workflows/workflow-node-duplication"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

const nodes: WorkflowSourceNode[] = [{
  index: 0,
  id: "review",
  type: "agent",
  registrationId: "reviewer",
  value: { id: "review", type: "agent", agent: "reviewer", input: { task: "one" } },
}]

describe("duplicateWorkflowNodeOperations", () => {
  it("preserves configuration, creates a unique id, and chains after the anchor", () => {
    expect(duplicateWorkflowNodeOperations(nodes, nodes[0]!.value, "review")).toEqual({
      id: "review_copy",
      operations: [{
        op: "sequence_insert",
        path: ["nodes"],
        index: 1,
        value: {
          id: "review_copy",
          type: "agent",
          agent: "reviewer",
          input: { task: "one" },
          after: ["review"],
        },
      }],
    })
  })

  it("increments an existing copy suffix", () => {
    const existing = [...nodes, { ...nodes[0]!, index: 1, id: "review_copy" }]
    expect(duplicateWorkflowNodeOperations(existing, nodes[0]!.value)?.id).toBe("review_copy_2")
  })
})
