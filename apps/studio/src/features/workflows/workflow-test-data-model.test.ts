import { describe, expect, it } from "vitest"

import {
  workflowNodeTestDataStates,
  workflowTestDataEntries,
} from "@/features/workflows/workflow-test-data-model"
import type { WorkflowExpressionFixtureSource } from "@/features/workflows/workflow-expression-fixtures"

const DIGEST = `sha256:${"a".repeat(64)}`

function source(nodeId: string, redactionChanged = false): WorkflowExpressionFixtureSource {
  return {
    kind: "run_node_output",
    run_id: `run-${nodeId}`,
    workflow_id: "code-review",
    node_id: nodeId,
    graph_hash: DIGEST,
    outcome_hash: DIGEST,
    workflow_revision: DIGEST,
    definition_bundle_hash: DIGEST,
    captured_at: "2026-07-12T12:00:00.000Z",
    redaction_changed: redactionChanged,
    definition_source: { kind: "installed" },
  }
}

describe("workflowTestDataEntries", () => {
  it("keeps every fixture and explains manual, eligible, missing-node, and redacted states", () => {
    const entries = workflowTestDataEntries(
      {
        manual: { input: 1 },
        eligible: { output: "ok" },
        orphan: { output: "old" },
      },
      {
        eligible: source("review", true),
        orphan: source("removed"),
      },
      new Set(["review"]),
    )

    expect(entries.map((entry) => entry.name)).toEqual(["eligible", "manual", "orphan"])
    expect(entries[0]).toMatchObject({ eligibility: { kind: "preview_only", reason: "redacted" }, redacted: true })
    expect(entries[1]).toMatchObject({ eligibility: { kind: "preview_only", reason: "manual" } })
    expect(entries[2]).toMatchObject({ eligibility: { kind: "preview_only", reason: "node_missing" } })
  })

  it("marks every selected source node active while retaining saved badges on other nodes", () => {
    const entries = workflowTestDataEntries(
      { first: 1, active: 2, another: 3 },
      { first: source("one"), active: source("two"), another: source("two") },
      new Set(["one", "two"]),
    )

    expect([...workflowNodeTestDataStates(entries, new Set(["active", "first"]))]).toEqual([
      ["two", "active"],
      ["one", "active"],
    ])
  })
})
