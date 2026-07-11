import { describe, expect, it } from "vitest";
import {
  RunRecordSchema
} from "../../../src/studio/contracts/runs.js";
import {
  applyRunTransition,
  initialRunRecord,
  wallDurationMs
} from "../../../src/studio/application/runs/lifecycle.js";
import { RunStoreError } from "../../../src/studio/application/runs/errors.js";
import { preallocation } from "./helpers.js";

describe("run lifecycle", () => {
  it("builds a strict, versioned queued record with complete metadata", () => {
    const record = initialRunRecord(preallocation("run-1"));

    expect(record).toMatchObject({
      schema_version: 1,
      record_revision: 1,
      run_id: "run-1",
      dispatch_status: "queued",
      completeness: "complete"
    });
    expect(RunRecordSchema.safeParse({ ...record, unknown: true }).success).toBe(false);
    expect(RunRecordSchema.safeParse({
      ...record,
      definition_bundle_hash: undefined
    }).success).toBe(false);
    expect(RunRecordSchema.safeParse({
      ...record,
      failure: { code: "unexpected", message: "Not terminal" }
    }).success).toBe(false);
  });

  it("keeps graph snapshots opaque and rejects physical-looking handles", () => {
    const record = initialRunRecord(preallocation("run-1"));

    expect(RunRecordSchema.safeParse({
      ...record,
      graph_snapshot_handle: "/tmp/run/graph.json"
    }).success).toBe(false);
  });

  it("enforces canonical dispatch and runtime transitions", () => {
    const queued = initialRunRecord(preallocation("run-1"));
    const preparing = applyRunTransition(queued, {
      kind: "dispatch_preparing",
      owner_id: "worker-1"
    }, "2026-07-10T12:00:01.000Z");
    const started = applyRunTransition(preparing, {
      kind: "dispatch_started",
      owner_id: "worker-1",
      active_node_ids: ["collect-context"]
    }, "2026-07-10T12:00:02.000Z");
    const waiting = applyRunTransition(started, {
      kind: "runtime_status",
      owner_id: "worker-1",
      status: "waiting_for_input",
      active_node_ids: []
    }, "2026-07-10T12:00:03.000Z");
    const resuming = applyRunTransition(waiting, {
      kind: "runtime_status",
      owner_id: "worker-1",
      status: "resuming",
      active_node_ids: []
    }, "2026-07-10T12:00:04.000Z");
    const running = applyRunTransition(resuming, {
      kind: "runtime_status",
      owner_id: "worker-1",
      status: "running",
      active_node_ids: ["review"]
    }, "2026-07-10T12:00:05.000Z");
    const succeeded = applyRunTransition(running, {
      kind: "runtime_status",
      owner_id: "worker-1",
      status: "succeeded",
      active_node_ids: [],
      artifact_count: 2
    }, "2026-07-10T12:00:12.000Z");

    expect(succeeded.record_revision).toBe(7);
    expect(succeeded.finished_at).toBe("2026-07-10T12:00:12.000Z");
    expect(wallDurationMs(succeeded, "2030-01-01T00:00:00.000Z")).toBe(10_000);
    expect(() => applyRunTransition(succeeded, {
      kind: "heartbeat",
      owner_id: "worker-1"
    }, "2026-07-10T12:00:13.000Z")).toThrowError(RunStoreError);
  });

  it("rejects owner mismatch, time regression, illegal jumps, and decreasing counts", () => {
    const queued = initialRunRecord(preallocation("run-1"));
    expect(() => applyRunTransition(queued, {
      kind: "dispatch_started",
      owner_id: "worker-1",
      active_node_ids: []
    }, "2026-07-10T12:00:01.000Z")).toThrowError(/Only prepared/);

    const preparing = applyRunTransition(queued, {
      kind: "dispatch_preparing",
      owner_id: "worker-1"
    }, "2026-07-10T12:00:01.000Z");
    expect(() => applyRunTransition(preparing, {
      kind: "heartbeat",
      owner_id: "worker-2"
    }, "2026-07-10T12:00:02.000Z")).toThrowError(/owner/i);
    expect(() => applyRunTransition(preparing, {
      kind: "heartbeat",
      owner_id: "worker-1"
    }, "2026-07-10T11:59:59.000Z")).toThrowError(/backwards/);

    const started = applyRunTransition(preparing, {
      kind: "dispatch_started",
      owner_id: "worker-1",
      active_node_ids: []
    }, "2026-07-10T12:00:02.000Z");
    const progressed = applyRunTransition(started, {
      kind: "progress",
      owner_id: "worker-1",
      active_node_ids: [],
      artifact_count: 2
    }, "2026-07-10T12:00:03.000Z");
    expect(() => applyRunTransition(progressed, {
      kind: "progress",
      owner_id: "worker-1",
      active_node_ids: [],
      artifact_count: 1
    }, "2026-07-10T12:00:04.000Z")).toThrowError(/cannot decrease/);
  });
});
