import { describe, expect, it } from "vitest"

import { studioResponseContracts } from "@/api/response-contracts"

const DIGEST = `sha256:${"a".repeat(64)}`

describe("Studio response contracts", () => {
  it("rejects internal graph handles at the browser boundary", () => {
    expect(() =>
      studioResponseContracts.run.parse({
        record: {
          schema_version: 1,
          record_revision: 1,
          run_id: "run-public-boundary",
          workflow_id: "code-review",
          workflow_revision: DIGEST,
          definition_bundle_hash: DIGEST,
          catalog_fingerprint: DIGEST,
          execution_snapshot_hash: DIGEST,
          graph_snapshot_handle: `gs_${"A".repeat(32)}`,
          dispatch_status: "queued",
          created_at: "2026-07-11T12:00:00.000Z",
          updated_at: "2026-07-11T12:00:00.000Z",
          active_node_ids: [],
          artifact_count: 0,
          interrupt_count: 0,
          side_effects: [],
          completeness: "complete",
        },
        status: "queued",
        wall_duration_ms: 0,
      }),
    ).toThrow("Internal graph handles")
  })

  it("keeps historical status and unavailable lifecycle metrics explicit", () => {
    const response = {
      record: {
        schema_version: 1,
        record_revision: 1,
        run_id: "historical-run",
        workflow_id: "code-review",
        dispatch_status: "historical_unknown",
        created_at: "2026-07-11T12:00:00.000Z",
        updated_at: "2026-07-11T12:00:00.000Z",
        active_node_ids: [],
        side_effects: [],
        lifecycle_projection: "unknown",
        completeness: "legacy",
      },
      status: "historical_unknown",
    }

    const parsed = studioResponseContracts.run.parse(response)
    expect(parsed).toMatchObject({
      record: {
        dispatch_status: "historical_unknown",
        lifecycle_projection: "unknown",
      },
      status: "historical_unknown",
    })
    expect(parsed.record.artifact_count).toBeUndefined()
    expect(parsed.record.interrupt_count).toBeUndefined()
    expect(parsed.wall_duration_ms).toBeUndefined()
    expect(() => studioResponseContracts.run.parse({
      ...response,
      record: { ...response.record, artifact_count: 0 },
      wall_duration_ms: 0,
    })).toThrow()
  })

  it("accepts only bounded versioned artifact semantic metadata", () => {
    const response = {
      run_id: "run-artifacts",
      items: [
        {
          manifest_handle: `ah_${"a".repeat(43)}`,
          name: "findings.json",
          attempt: 1,
          media_type: "application/json",
          semantic_type: "luna.review.findings.v1",
          status: "committed",
          created_at: "2026-07-11T12:00:00.000Z",
          preview_capability: "probe_required",
        },
      ],
      redaction: "best_effort_on_preview",
    }

    expect(studioResponseContracts.artifacts.parse(response)).toMatchObject({
      items: [{ semantic_type: "luna.review.findings.v1" }],
    })
    expect(() =>
      studioResponseContracts.artifacts.parse({
        ...response,
        items: [{ ...response.items[0], semantic_type: "unversioned" }],
      }),
    ).toThrow()
  })
})
