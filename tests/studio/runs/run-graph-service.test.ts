import { describe, expect, it, vi } from "vitest";
import {
  startNodeAttempt,
  succeedNode
} from "../../../src/core/runtime/lifecycle.js";
import { createInitialRuntimeState } from "../../../src/core/runtime/state.js";
import type { CompiledWorkflow } from "../../../src/core/workflow/compiler.js";
import { sha256Digest } from "../../../src/core/workflow/definition-digests.js";
import {
  RunGraphReadError,
  RunGraphService
} from "../../../src/studio/application/runs/graph-service.js";
import {
  projectStoredRunGraphOutcome,
  projectStoredRunGraphSnapshot,
  type RunGraphSnapshotReadResult,
  type RunGraphSnapshotStorePort,
  type StoredRunGraphOutcome,
  type StoredRunGraphSnapshot
} from "../../../src/studio/application/runs/graph-snapshot.js";
import type { RunLedgerPort } from "../../../src/studio/application/runs/ports.js";
import {
  RunRecordSchema,
  type RunRecord
} from "../../../src/studio/contracts/runs.js";
import { DIGEST_A, DIGEST_B, DIGEST_C, DIGEST_D } from "./helpers.js";

const HANDLE = `gs_${"A".repeat(22)}`;

function compiled(): CompiledWorkflow {
  return {
    workflow_id: "code-review",
    workflow_revision: DIGEST_A,
    state_schema_version: "2026-06",
    nodes: [
      {
        id: "review",
        kind: "agent",
        yaml_path: "$.graph.nodes[0]",
        capability_id: "agents",
        output_schema: {},
        can_create_pending_interrupt: false,
        source: {}
      },
      {
        id: "publish",
        kind: "built_in",
        yaml_path: "$.graph.nodes[1]",
        capability_id: "github.publish_review",
        output_schema: {},
        can_create_pending_interrupt: false,
        source: {}
      }
    ],
    edges: [{ from: "review", to: "publish" }],
    state: { channels: {} }
  } as unknown as CompiledWorkflow;
}

function graph(runId = "run-service-1") {
  return projectStoredRunGraphSnapshot({
    identity: {
      graph_snapshot_handle: HANDLE,
      run_id: runId,
      workflow_id: "code-review",
      workflow_revision: DIGEST_A,
      definition_bundle_hash: DIGEST_B,
      execution_snapshot_hash: DIGEST_D
    },
    compiled: compiled()
  });
}

function terminalOutcome(
  snapshot: StoredRunGraphSnapshot,
  recordRevision = 4
): StoredRunGraphOutcome {
  let state = createInitialRuntimeState({
    invocation: {},
    config: {},
    run: {
      run_id: snapshot.identity.run_id,
      workflow_id: snapshot.identity.workflow_id,
      attempt: 1,
      started_at: "2026-07-11T10:00:01.000Z"
    },
    workflow: { id: snapshot.identity.workflow_id }
  });
  state = startNodeAttempt(state, "review", 1);
  state = succeedNode(state, "review");
  state = { ...state, run_status: "succeeded" };
  return projectStoredRunGraphOutcome({
    graphSnapshot: snapshot,
    recordRevision,
    state
  });
}

function terminalRecord(overrides: Record<string, unknown> = {}): RunRecord {
  return RunRecordSchema.parse({
    schema_version: 1,
    record_revision: 4,
    run_id: "run-service-1",
    workflow_id: "code-review",
    workflow_revision: DIGEST_A,
    definition_bundle_hash: DIGEST_B,
    catalog_fingerprint: DIGEST_C,
    execution_snapshot_hash: DIGEST_D,
    dispatch_status: "started",
    run_status: "succeeded",
    created_at: "2026-07-11T10:00:00.000Z",
    updated_at: "2026-07-11T10:00:03.000Z",
    started_at: "2026-07-11T10:00:01.000Z",
    finished_at: "2026-07-11T10:00:03.000Z",
    owner_id: "worker-1",
    owner_claimed_at: "2026-07-11T10:00:00.500Z",
    heartbeat_at: "2026-07-11T10:00:02.000Z",
    active_node_ids: [],
    graph_snapshot_handle: HANDLE,
    artifact_count: 0,
    interrupt_count: 0,
    side_effects: [],
    completeness: "complete",
    ...overrides
  });
}

function runningRecord(): RunRecord {
  return terminalRecord({
    record_revision: 3,
    run_status: "running",
    updated_at: "2026-07-11T10:00:02.000Z",
    finished_at: undefined,
    active_node_ids: ["review"]
  });
}

function queuedRecord(overrides: Record<string, unknown> = {}): RunRecord {
  return terminalRecord({
    record_revision: 1,
    dispatch_status: "queued",
    run_status: undefined,
    updated_at: "2026-07-11T10:00:00.000Z",
    started_at: undefined,
    finished_at: undefined,
    owner_id: undefined,
    owner_claimed_at: undefined,
    heartbeat_at: undefined,
    active_node_ids: [],
    ...overrides
  });
}

function ledger(record: RunRecord | undefined): RunLedgerPort {
  return {
    preallocate: vi.fn(async () => {
      throw new Error("not used");
    }),
    appendTransition: vi.fn(async () => {
      throw new Error("not used");
    }),
    get: vi.fn(async () => record),
    listOrphanCandidates: vi.fn(async () => [])
  };
}

function store(input: {
  graph?: RunGraphSnapshotReadResult<StoredRunGraphSnapshot>;
  outcome?: RunGraphSnapshotReadResult<StoredRunGraphOutcome>;
}): RunGraphSnapshotStorePort {
  const graphResult: RunGraphSnapshotReadResult<StoredRunGraphSnapshot> =
    input.graph ?? { kind: "missing" };
  const outcomeResult: RunGraphSnapshotReadResult<StoredRunGraphOutcome> =
    input.outcome ?? { kind: "missing" };
  return {
    initialize: vi.fn(async () => undefined),
    writeGraph: vi.fn(async () => undefined),
    writeOutcome: vi.fn(async () => undefined),
    readGraph: vi.fn(async () => graphResult),
    readOutcome: vi.fn(async () => outcomeResult)
  };
}

describe("run graph read service", () => {
  it("returns only the exact pinned graph and definitive terminal outcome", async () => {
    const snapshot = graph();
    const service = new RunGraphService({
      ledger: ledger(terminalRecord()),
      store: store({
        graph: { kind: "available", value: snapshot },
        outcome: { kind: "available", value: terminalOutcome(snapshot) }
      })
    });

    const response = await service.get("run-service-1");
    expect(response).toMatchObject({
      availability: "available",
      run: {
        workflow_revision: DIGEST_A,
        execution_snapshot_hash: DIGEST_D
      },
      graph_hash: snapshot.graph_hash,
      overlay: {
        observation: "observed",
        source: "persisted",
        record_revision: 4,
        nodes: [{ node_id: "review", status: "succeeded", attempt_count: 1 }]
      }
    });
    expect(JSON.stringify(response)).not.toContain("graph_snapshot_handle");
  });

  it("degrades legacy and pre-execution crash windows explicitly", async () => {
    const legacy = queuedRecord({
      completeness: "legacy",
      workflow_revision: undefined,
      definition_bundle_hash: undefined,
      catalog_fingerprint: undefined,
      execution_snapshot_hash: undefined,
      graph_snapshot_handle: undefined
    });
    const legacyService = new RunGraphService({
      ledger: ledger(legacy),
      store: store({})
    });
    await expect(legacyService.get(legacy.run_id)).resolves.toMatchObject({
      availability: "legacy",
      reason: "legacy_run_without_snapshot"
    });

    const partialService = new RunGraphService({
      ledger: ledger(queuedRecord({ completeness: "partial" })),
      store: store({ graph: { kind: "available", value: graph() } })
    });
    await expect(partialService.get("run-service-1")).resolves.toMatchObject({
      availability: "unavailable",
      reason: "partial_run_without_snapshot"
    });

    const pendingService = new RunGraphService({
      ledger: ledger(queuedRecord()),
      store: store({ graph: { kind: "missing" } })
    });
    await expect(pendingService.get("run-service-1")).resolves.toMatchObject({
      availability: "pending",
      reason: "graph_not_persisted_yet"
    });
  });

  it("never substitutes the current workflow for a mismatched run snapshot", async () => {
    const service = new RunGraphService({
      ledger: ledger(terminalRecord()),
      store: store({
        graph: { kind: "available", value: graph("another-run") }
      })
    });

    await expect(service.get("run-service-1")).resolves.toMatchObject({
      availability: "corrupt",
      reason: "graph_snapshot_identity_mismatch"
    });
  });

  it("degrades corrupt graph and outcome contracts without inventing nodes", async () => {
    const snapshot = graph();
    const corruptGraphService = new RunGraphService({
      ledger: ledger(terminalRecord()),
      store: store({
        graph: {
          kind: "available",
          value: {
            ...snapshot,
            graph: { ...snapshot.graph, nodes: [] }
          } as StoredRunGraphSnapshot
        }
      })
    });
    await expect(corruptGraphService.get("run-service-1")).resolves.toMatchObject({
      availability: "corrupt",
      reason: "graph_snapshot_invalid"
    });

    const corruptOutcome = {
      ...terminalOutcome(snapshot),
      nodes: [{ node_id: "review", status: "future", attempt_count: 99 }]
    } as unknown as StoredRunGraphOutcome;
    const corruptOutcomeService = new RunGraphService({
      ledger: ledger(terminalRecord()),
      store: store({
        graph: { kind: "available", value: snapshot },
        outcome: { kind: "available", value: corruptOutcome }
      })
    });
    await expect(corruptOutcomeService.get("run-service-1")).resolves.toMatchObject({
      availability: "available",
      overlay: { observation: "unobservable", reason: "outcome_corrupt" }
    });

    const baseOutcome = terminalOutcome(snapshot);
    const unknownMaterial = {
      schema_version: baseOutcome.schema_version,
      identity: baseOutcome.identity,
      graph_hash: baseOutcome.graph_hash,
      record_revision: baseOutcome.record_revision,
      run_status: baseOutcome.run_status,
      nodes: [{ node_id: "intruder", status: "succeeded" as const }]
    };
    const unknownOutcome = {
      ...unknownMaterial,
      outcome_hash: sha256Digest(unknownMaterial)
    };
    const unknownOutcomeService = new RunGraphService({
      ledger: ledger(terminalRecord()),
      store: store({
        graph: { kind: "available", value: snapshot },
        outcome: { kind: "available", value: unknownOutcome }
      })
    });
    await expect(unknownOutcomeService.get("run-service-1")).resolves.toMatchObject({
      availability: "available",
      overlay: { observation: "unobservable", reason: "outcome_corrupt" }
    });
  });

  it("marks a terminal outcome stale when its ledger revision is not definitive", async () => {
    const snapshot = graph();
    const service = new RunGraphService({
      ledger: ledger(terminalRecord()),
      store: store({
        graph: { kind: "available", value: snapshot },
        outcome: {
          kind: "available",
          value: terminalOutcome(snapshot, 3)
        }
      })
    });

    await expect(service.get("run-service-1")).resolves.toMatchObject({
      availability: "available",
      overlay: { observation: "unobservable", reason: "outcome_stale" }
    });
  });

  it("degrades a crash after the terminal ledger write without inferring an outcome", async () => {
    const snapshot = graph();
    const service = new RunGraphService({
      ledger: ledger(terminalRecord({
        run_status: "failed",
        failure: { code: "runtime_node_failed", message: "Runtime failed" }
      })),
      store: store({
        graph: { kind: "available", value: snapshot },
        outcome: { kind: "missing" }
      })
    });

    await expect(service.get("run-service-1")).resolves.toMatchObject({
      availability: "available",
      run: { status: "failed" },
      overlay: { observation: "unobservable", reason: "outcome_missing" }
    });
  });

  it("projects live nodes only from the canonical active-node observation", async () => {
    const snapshot = graph();
    const service = new RunGraphService({
      ledger: ledger(runningRecord()),
      store: store({ graph: { kind: "available", value: snapshot } })
    });
    await expect(service.get("run-service-1")).resolves.toMatchObject({
      availability: "available",
      overlay: {
        observation: "observed",
        source: "live",
        record_revision: 3,
        run_status: "running",
        nodes: [{ node_id: "review", status: "running" }]
      }
    });
  });

  it("rejects active ids outside the immutable graph", async () => {
    const snapshot = graph();
    const service = new RunGraphService({
      ledger: ledger(RunRecordSchema.parse({
        ...runningRecord(),
        active_node_ids: ["intruder"]
      })),
      store: store({ graph: { kind: "available", value: snapshot } })
    });
    await expect(service.get("run-service-1")).resolves.toMatchObject({
      availability: "available",
      overlay: {
        observation: "unobservable",
        reason: "live_projection_invalid"
      }
    });
  });

  it("rejects invalid and unknown run ids before reading snapshots", async () => {
    const service = new RunGraphService({
      ledger: ledger(undefined),
      store: store({})
    });
    await expect(service.get("../private")).rejects.toBeInstanceOf(RunGraphReadError);
    await expect(service.get("missing-run")).rejects.toMatchObject({
      code: "run_graph_run_not_found"
    });
  });
});
