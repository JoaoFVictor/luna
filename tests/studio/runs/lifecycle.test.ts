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

  it("models historical lifecycle as immutable and unavailable", () => {
    const historical = RunRecordSchema.parse({
      schema_version: 1,
      record_revision: 1,
      run_id: "historical-run",
      workflow_id: "code-review",
      dispatch_status: "historical_unknown",
      created_at: "2026-07-10T12:00:00.000Z",
      updated_at: "2026-07-10T12:00:00.000Z",
      active_node_ids: [],
      side_effects: [],
      lifecycle_projection: "unknown",
      completeness: "legacy"
    });

    expect(historical.artifact_count).toBeUndefined();
    expect(historical.interrupt_count).toBeUndefined();
    expect(wallDurationMs(historical, "2030-01-01T00:00:00.000Z"))
      .toBeUndefined();
    expect(() => applyRunTransition(historical, {
      kind: "dispatch_preparing",
      owner_id: "worker-1"
    }, "2026-07-10T12:00:01.000Z")).toThrowError(RunStoreError);
    expect(RunRecordSchema.safeParse({
      ...historical,
      artifact_count: 0
    }).success).toBe(false);
    expect(RunRecordSchema.safeParse({
      ...historical,
      lifecycle_projection: "exact"
    }).success).toBe(false);
    expect(RunRecordSchema.safeParse({
      ...historical,
      owner_id: "worker-1",
      owner_claimed_at: historical.created_at,
      heartbeat_at: historical.created_at
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
    expect(succeeded.completeness).toBe("partial");
    expect(wallDurationMs(succeeded, "2030-01-01T00:00:00.000Z")).toBe(10_000);
    expect(() => applyRunTransition(succeeded, {
      kind: "heartbeat",
      owner_id: "worker-1"
    }, "2026-07-10T12:00:13.000Z")).toThrowError(RunStoreError);
  });

  it("rejects a complete terminal record without a durable outcome proof", () => {
    const queued = initialRunRecord(preallocation("run-1"));
    const preparing = applyRunTransition(queued, {
      kind: "dispatch_preparing",
      owner_id: "worker-1"
    }, "2026-07-10T12:00:01.000Z");
    const started = applyRunTransition(preparing, {
      kind: "dispatch_started",
      owner_id: "worker-1",
      active_node_ids: []
    }, "2026-07-10T12:00:02.000Z");

    expect(() => applyRunTransition(started, {
        kind: "runtime_status",
        owner_id: "worker-1",
        status: "succeeded",
        active_node_ids: [],
        completeness: "complete"
      }, "2026-07-10T12:00:03.000Z"))
      .toThrowError(/outcome proof/i);
  });

  it("claims only an unfinished running owner for crash recovery", () => {
    const queued = initialRunRecord(preallocation("run-recovery"));
    const preparing = applyRunTransition(queued, {
      kind: "dispatch_preparing",
      owner_id: "worker-old"
    }, "2026-07-10T12:00:01.000Z");
    const started = applyRunTransition(preparing, {
      kind: "dispatch_started",
      owner_id: "worker-old",
      active_node_ids: ["analyze"]
    }, "2026-07-10T12:00:02.000Z");

    expect(() => applyRunTransition(started, {
      kind: "dispatch_recovery_claim",
      previous_owner_id: "worker-wrong",
      owner_id: "worker-new"
    }, "2026-07-10T12:01:00.000Z")).toThrowError(/previous run owner/i);

    const recovered = applyRunTransition(started, {
      kind: "dispatch_recovery_claim",
      previous_owner_id: "worker-old",
      owner_id: "worker-new"
    }, "2026-07-10T12:01:00.000Z");
    expect(recovered).toMatchObject({
      dispatch_status: "started",
      run_status: "running",
      owner_id: "worker-new",
      active_node_ids: [],
      heartbeat_at: "2026-07-10T12:01:00.000Z"
    });
    expect(recovered.started_at).toBe(started.started_at);
    expect(recovered.owner_claimed_at).toBe(started.owner_claimed_at);
  });

  it("merges lifecycle counts from parallel branches without false regression", () => {
    const queued = initialRunRecord(preallocation("run-1"));
    const preparing = applyRunTransition(queued, {
      kind: "dispatch_preparing",
      owner_id: "worker-1"
    }, "2026-07-10T12:00:01.000Z");
    const started = applyRunTransition(preparing, {
      kind: "dispatch_started",
      owner_id: "worker-1",
      active_node_ids: []
    }, "2026-07-10T12:00:02.000Z");
    const artifactPublished = applyRunTransition(started, {
      kind: "node_lifecycle",
      owner_id: "worker-1",
      event: {
        type: "node.succeeded",
        node_id: "branch-a",
        attempt: 1,
        observed_at: "2026-07-10T12:00:04.000Z",
        artifact_count: 1,
        interrupt_count: 0
      }
    }, "2026-07-10T12:00:04.000Z");
    const siblingStarted = applyRunTransition(artifactPublished, {
      kind: "node_lifecycle",
      owner_id: "worker-1",
      event: {
        type: "node.started",
        node_id: "branch-b",
        attempt: 1,
        observed_at: "2026-07-10T12:00:03.000Z",
        artifact_count: 0,
        interrupt_count: 0
      }
    }, "2026-07-10T12:00:03.000Z");

    expect(siblingStarted).toMatchObject({
      active_node_ids: ["branch-b"],
      artifact_count: 1,
      interrupt_count: 0,
      updated_at: "2026-07-10T12:00:04.000Z"
    });
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
