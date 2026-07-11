import { describe, expect, it } from "vitest"

import { workflowOperationHistoryEntry } from "@/features/workflows/workflow-operation-history"

describe("workflowOperationHistoryEntry", () => {
  it("builds reversed inverse operations for an atomic edit", () => {
    expect(workflowOperationHistoryEntry(
      { nodes: [{ id: "one", after: ["start"] }] },
      [
        { op: "set", path: ["nodes", 0, "after"], value: ["start", "other"] },
        { op: "sequence_insert", path: ["nodes"], value: { id: "two" } },
      ],
    )?.backward).toEqual([
      { op: "sequence_remove", path: ["nodes"], index: 1 },
      { op: "set", path: ["nodes", 0, "after"], value: ["start"] },
    ])
  })

  it("restores removed sequence values at the original index", () => {
    expect(workflowOperationHistoryEntry(
      { capabilities: ["one", "two"] },
      [{ op: "sequence_remove", path: ["capabilities"], index: 0 }],
    )?.backward).toEqual([
      { op: "sequence_insert", path: ["capabilities"], index: 0, value: "one" },
    ])
  })

  it("rejects an edit that cannot be projected safely", () => {
    expect(workflowOperationHistoryEntry(
      { nodes: [] },
      [{ op: "delete", path: ["missing"] }],
    )).toBeUndefined()
  })
})
