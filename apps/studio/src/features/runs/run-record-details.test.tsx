import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { RunRecord } from "@/api/types"
import { RunRecordDetails } from "@/features/runs/run-record-details"

const DIGEST = `sha256:${"a".repeat(64)}`

const record: RunRecord = {
  schema_version: 1,
  record_revision: 2,
  run_id: "run-details-test",
  workflow_id: "generic-workflow",
  workflow_revision: DIGEST,
  definition_bundle_hash: DIGEST,
  dispatch_status: "started",
  run_status: "outcome_unknown",
  created_at: "2026-07-12T12:00:00.000Z",
  updated_at: "2026-07-12T12:00:03.000Z",
  started_at: "2026-07-12T12:00:01.000Z",
  finished_at: "2026-07-12T12:00:03.000Z",
  active_node_ids: [],
  artifact_count: 1,
  interrupt_count: 0,
  side_effects: [
    {
      category: "repository_write",
      confirmation_required: true,
      description: "Workspace may update a repository",
      node_id: "workspace",
      operation_id: "workspace.capture",
    },
  ],
  lifecycle_projection: "exact",
  completeness: "complete",
}

describe("RunRecordDetails", () => {
  it("presents side effects as readable actions and keeps raw data collapsed", () => {
    render(<RunRecordDetails record={record} />)

    expect(screen.getByText("Workspace may update a repository")).toBeDefined()
    expect(screen.getByText("Repository write")).toBeDefined()
    expect(screen.getByText("Workspace · workspace.capture")).toBeDefined()
    expect(screen.getByText("Confirmação necessária")).toBeDefined()
    expect(screen.queryByText('"operation_id"')).toBeNull()

    fireEvent.click(screen.getByText("Dados técnicos"))
    expect(screen.getAllByText(/workspace\.capture/).length).toBeGreaterThan(1)
    expect(screen.getByLabelText("Ações previstas").className).not.toContain("overflow-y-auto")
  })
})
