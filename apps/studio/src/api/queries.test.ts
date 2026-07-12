import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { artifactsRefetchInterval, runRefetchInterval } from "@/api/queries"
import type { ArtifactList, RunCatalogItem } from "@/api/types"

const TERMINAL_AT = "2026-07-12T12:00:00.000Z"
const TERMINAL_TIME = Date.parse(TERMINAL_AT)

function runItem({
  status,
  finishedAt,
}: {
  status: "running" | "succeeded" | "historical_unknown"
  finishedAt?: string
}): RunCatalogItem {
  return {
    record: {
      schema_version: 1,
      record_revision: 1,
      run_id: "run-polling",
      workflow_id: "review",
      dispatch_status: status === "historical_unknown" ? "historical_unknown" : "started",
      ...(status === "historical_unknown" ? {} : { run_status: status }),
      created_at: TERMINAL_AT,
      updated_at: TERMINAL_AT,
      ...(status === "historical_unknown" ? {} : {
        started_at: TERMINAL_AT,
        owner_id: "worker",
        owner_claimed_at: TERMINAL_AT,
        heartbeat_at: TERMINAL_AT,
        artifact_count: 0,
        interrupt_count: 0,
      }),
      ...(finishedAt === undefined ? {} : { finished_at: finishedAt }),
      active_node_ids: [],
      side_effects: [],
      lifecycle_projection: status === "historical_unknown" ? "unknown" : "exact",
      completeness: status === "historical_unknown" ? "legacy" : "complete",
    },
    status,
    ...(status === "historical_unknown" ? {} : { wall_duration_ms: 0 }),
  }
}

function artifacts(status: "pending" | "committed"): ArtifactList {
  return {
    run_id: "run-artifact-polling",
    redaction: "best_effort_on_preview",
    items: [{
      manifest_handle: `ah_${"a".repeat(43)}`,
      name: "result.json",
      attempt: 1,
      media_type: "application/json",
      status,
      created_at: TERMINAL_AT,
      preview_capability:
        status === "pending" ? "unavailable" : "probe_required",
    }],
  }
}

describe("run query polling policy", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(TERMINAL_TIME)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps active records and timelines updated", () => {
    expect(runRefetchInterval(runItem({ status: "running" }))).toBe(5_000)
  })

  it("allows a short terminal persistence catch-up and then stops", () => {
    const terminal = runItem({ status: "succeeded", finishedAt: TERMINAL_AT })

    expect(runRefetchInterval(terminal)).toBe(2_000)
    vi.setSystemTime(TERMINAL_TIME + 15_000)
    expect(runRefetchInterval(terminal)).toBe(false)
  })

  it("does not poll immutable historical records without a finish timestamp", () => {
    expect(runRefetchInterval(runItem({ status: "historical_unknown" }))).toBe(false)
  })
})

describe("artifact query polling policy", () => {
  it("keeps active runs responsive while artifacts are still being persisted", () => {
    expect(artifactsRefetchInterval(
      artifacts("pending"),
      1,
      undefined,
      TERMINAL_TIME + 86_400_000,
    )).toBe(750)
  })

  it("backs off terminal persistence catch-up and stops at the deadline", () => {
    const pending = artifacts("pending")

    expect(artifactsRefetchInterval(
      pending,
      1,
      TERMINAL_AT,
      TERMINAL_TIME + 9_999,
    )).toBe(750)
    expect(artifactsRefetchInterval(
      pending,
      1,
      TERMINAL_AT,
      TERMINAL_TIME + 10_000,
    )).toBe(2_000)
    expect(artifactsRefetchInterval(
      pending,
      1,
      TERMINAL_AT,
      TERMINAL_TIME + 30_000,
    )).toBe(10_000)
    expect(artifactsRefetchInterval(
      pending,
      1,
      TERMINAL_AT,
      TERMINAL_TIME + 120_000,
    )).toBe(false)
  })

  it("uses the same finite policy when an expected terminal artifact is missing", () => {
    const empty = { ...artifacts("committed"), items: [] }

    expect(artifactsRefetchInterval(
      empty,
      1,
      TERMINAL_AT,
      TERMINAL_TIME + 45_000,
    )).toBe(10_000)
    expect(artifactsRefetchInterval(
      empty,
      1,
      TERMINAL_AT,
      TERMINAL_TIME + 120_000,
    )).toBe(false)
  })

  it("stops immediately once every artifact is committed and visible", () => {
    expect(artifactsRefetchInterval(
      artifacts("committed"),
      1,
      TERMINAL_AT,
      TERMINAL_TIME + 1_000,
    )).toBe(false)
    expect(artifactsRefetchInterval(
      undefined,
      1,
      TERMINAL_AT,
      TERMINAL_TIME,
    )).toBe(false)
  })
})
