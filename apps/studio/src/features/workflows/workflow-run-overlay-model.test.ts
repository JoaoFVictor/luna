import { describe, expect, it } from "vitest"

import type { RunGraphResponse, RunRecord } from "@/api/types"
import {
  workflowRunExecutionProjection,
  workflowRunOverlay,
} from "@/features/workflows/workflow-run-overlay-model"

const REVISION = `sha256:${"a".repeat(64)}`
const OTHER_REVISION = `sha256:${"b".repeat(64)}`

function response(revision = REVISION): RunGraphResponse {
  return {
    schema_version: 1,
    availability: "available",
    run: {
      run_id: "run-overlay",
      workflow_id: "workflow",
      workflow_revision: revision,
      definition_bundle_hash: REVISION,
      execution_snapshot_hash: REVISION,
      status: "failed",
      completeness: "complete",
    },
    graph_hash: REVISION,
    graph: {
      state_schema_version: "1",
      nodes: [
        { id: "collect", kind: "built_in", capability_id: "collect", can_create_pending_interrupt: false },
        { id: "report", kind: "built_in", capability_id: "report", can_create_pending_interrupt: false },
      ],
      edges: [{ from: "collect", to: "report" }],
    },
    overlay: {
      observation: "observed",
      source: "persisted",
      history: "complete",
      record_revision: 2,
      run_status: "failed",
      nodes: [
        { node_id: "collect", status: "succeeded", attempt_count: 1 },
        { node_id: "report", status: "failed", attempt_count: 2 },
      ],
    },
  }
}

describe("workflowRunOverlay", () => {
  it("projects observed status only when the compiled revision matches", () => {
    const overlay = workflowRunOverlay(REVISION, response(), undefined)
    expect(overlay.kind).toBe("compatible")
    if (overlay.kind !== "compatible") return
    expect(overlay.execution.get("collect")).toEqual({ status: "succeeded", attemptCount: 1 })
    expect(overlay.execution.get("report")).toEqual({ status: "failed", attemptCount: 2 })
  })

  it("refuses to paint a run from another revision", () => {
    expect(workflowRunOverlay(REVISION, response(OTHER_REVISION), undefined)).toEqual({
      kind: "revision_mismatch",
      runRevision: OTHER_REVISION,
    })
  })

  it("marks authorized supplied nodes without claiming they ran", () => {
    const record: Pick<RunRecord, "execution_profile" | "failed_node_id" | "failure"> = {
      execution_profile: {
        kind: "manual_test",
        test_data: [{
          kind: "draft_fixture",
          fixture_name: "collect-output",
          node_id: "collect",
          output_hash: REVISION,
          source: {
            kind: "run_node_output",
            run_id: "run-collect",
            workflow_id: "workflow",
            node_id: "collect",
            graph_hash: REVISION,
            outcome_hash: REVISION,
            workflow_revision: REVISION,
            definition_bundle_hash: REVISION,
            captured_at: "2026-07-11T12:00:00.000Z",
            redaction_changed: false,
            definition_source: { kind: "installed" },
          },
        }],
      },
      failed_node_id: "report",
      failure: { code: "failed", message: "boom" },
    }
    const overlay = workflowRunOverlay(REVISION, response(), record)
    expect(overlay.kind).toBe("compatible")
    if (overlay.kind !== "compatible") return
    expect(overlay.execution.get("collect")).toEqual({
      supplied: true,
    })
    expect(overlay.execution.get("report")?.primaryFailure).toBe(true)
  })

  it("uses the same canonical projection for artifact counts", () => {
    const available = response()
    if (available.availability !== "available") return
    const execution = workflowRunExecutionProjection(available, undefined, [{
      manifest_handle: `ah_${"a".repeat(43)}`,
      name: "report.json",
      source_node_id: "report",
      attempt: 1,
      media_type: "application/json",
      status: "committed",
      created_at: "2026-07-11T12:00:00.000Z",
      preview_capability: "probe_required",
    }])
    expect(execution.get("report")).toEqual({
      status: "failed",
      attemptCount: 2,
      artifactCount: 1,
    })
  })
})
