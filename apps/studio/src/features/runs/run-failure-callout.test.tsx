import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { RunRecord } from "@/api/types"
import { RunFailureCallout } from "@/features/runs/run-failure-callout"

const baseRecord: RunRecord = {
  schema_version: 1,
  record_revision: 2,
  run_id: "run-failure-copy",
  workflow_id: "review",
  dispatch_status: "started",
  run_status: "failed",
  created_at: "2026-07-12T10:00:00.000Z",
  updated_at: "2026-07-12T10:01:00.000Z",
  started_at: "2026-07-12T10:00:01.000Z",
  finished_at: "2026-07-12T10:01:00.000Z",
  active_node_ids: [],
  side_effects: [],
  failure: { code: "runtime_node_failed", message: "Node failed" },
  lifecycle_projection: "degraded",
  completeness: "partial",
}

describe("RunFailureCallout", () => {
  it("preserves completed work in the copy when a node failed", () => {
    render(<RunFailureCallout record={{ ...baseRecord, failed_node_id: "publish_review" }} />)

    expect(screen.getByText(/A execução parou em/).textContent).toContain("Publish review")
    expect(screen.getByText(/Passos concluídos antes da falha/)).toBeDefined()
  })

  it("states that no workflow step ran when dispatch was rejected", () => {
    render(<RunFailureCallout record={{
      ...baseRecord,
      dispatch_status: "rejected",
      run_status: undefined,
      started_at: undefined,
      finished_at: undefined,
      failure: { code: "dispatch_rejected", message: "Rejected" },
    }} />)

    expect(screen.getByText("O workflow foi rejeitado antes de qualquer passo começar.")).toBeDefined()
  })
})
