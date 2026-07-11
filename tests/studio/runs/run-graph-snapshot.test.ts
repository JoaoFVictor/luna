import { describe, expect, it } from "vitest";
import {
  failNode,
  startNodeAttempt
} from "../../../src/core/runtime/lifecycle.js";
import {
  createInitialRuntimeState,
  publishNodeOutput
} from "../../../src/core/runtime/state.js";
import type { CompiledWorkflow } from "../../../src/core/workflow/compiler.js";
import {
  StoredRunGraphOutcomeSchema,
  StoredRunGraphSnapshotSchema,
  createRunGraphSnapshotHandle,
  projectStoredRunGraphOutcome,
  projectStoredRunGraphSnapshot,
  type RunGraphSnapshotIdentity
} from "../../../src/studio/application/runs/graph-snapshot.js";
import { RunGraphResponseSchema } from "../../../src/studio/contracts/run-graph.js";
import { StudioRunExecuteRequestSchema } from "../../../src/studio/contracts/run-launch.js";
import { DIGEST_A, DIGEST_B, DIGEST_D } from "./helpers.js";

const HANDLE = `gs_${"A".repeat(22)}`;

function identity(
  overrides: Partial<RunGraphSnapshotIdentity> = {}
): RunGraphSnapshotIdentity {
  return {
    graph_snapshot_handle: HANDLE,
    run_id: "run-graph-1",
    workflow_id: "code-review",
    workflow_revision: DIGEST_A,
    definition_bundle_hash: DIGEST_B,
    execution_snapshot_hash: DIGEST_D,
    ...overrides
  };
}

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
        output_schema: { secret_schema: true },
        can_create_pending_interrupt: false,
        source: {
          id: "review",
          type: "agent",
          agent: "reviewer",
          prompt: { secret_prompt: true }
        }
      },
      {
        id: "publish",
        kind: "built_in",
        yaml_path: "$.graph.nodes[1]",
        capability_id: "github.publish_review",
        output_schema: {},
        can_create_pending_interrupt: false,
        source: {
          id: "publish",
          type: "built_in",
          uses: "github.publish_review",
          with: { secret_config: true },
          after: ["review"]
        }
      }
    ],
    edges: [
      { from: "__start__", to: "review" },
      { from: "review", to: "publish" },
      { from: "publish", to: "__end__" }
    ],
    state: { channels: {} }
  } as unknown as CompiledWorkflow;
}

describe("run graph snapshot projection", () => {
  it("creates opaque handles from exactly 24 bytes of entropy", () => {
    const handle = createRunGraphSnapshotHandle(() => new Uint8Array(24));
    expect(handle).toBe(`gs_${"A".repeat(32)}`);
    expect(() => createRunGraphSnapshotHandle(() => new Uint8Array(23))).toThrow(
      "exactly 24 bytes"
    );
  });

  it("projects only the public canonical DAG and binds its digest", () => {
    const snapshot = projectStoredRunGraphSnapshot({
      identity: identity(),
      compiled: compiled()
    });

    expect(snapshot.graph.nodes).toEqual([
      {
        id: "review",
        kind: "agent",
        capability_id: "agents",
        can_create_pending_interrupt: false
      },
      {
        id: "publish",
        kind: "built_in",
        capability_id: "github.publish_review",
        can_create_pending_interrupt: false
      }
    ]);
    expect(snapshot.graph.edges).toEqual([
      { from: "review", to: "publish" }
    ]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("yaml_path");
    expect(serialized).not.toContain("secret_prompt");
    expect(serialized).not.toContain("secret_config");
    expect(serialized).not.toContain("output_schema");

    expect(
      StoredRunGraphSnapshotSchema.safeParse({
        ...snapshot,
        graph: { ...snapshot.graph, edges: [] }
      }).success
    ).toBe(false);
  });

  it("rejects a compiled workflow from a different pinned revision", () => {
    expect(() =>
      projectStoredRunGraphSnapshot({
        identity: identity({ workflow_revision: DIGEST_B }),
        compiled: compiled()
      })
    ).toThrow("pinned run identity");
  });

  it("rejects unknown compiled edge endpoints instead of hiding them", () => {
    const source = compiled();
    expect(() =>
      projectStoredRunGraphSnapshot({
        identity: identity(),
        compiled: {
          ...source,
          edges: [...source.edges, { from: "unknown", to: "review" }]
        }
      })
    ).toThrow("unknown graph endpoint");
  });

  it("persists only real node statuses and exact attempt counts", () => {
    const snapshot = projectStoredRunGraphSnapshot({
      identity: identity(),
      compiled: compiled()
    });
    let state = createInitialRuntimeState({
      invocation: { token: "INVOCATION_SECRET" },
      config: { api_key: "CONFIG_SECRET" },
      run: {
        run_id: "run-graph-1",
        workflow_id: "code-review",
        attempt: 1,
        started_at: "2026-07-11T10:00:00.000Z"
      },
      workflow: { id: "code-review" }
    });
    state = startNodeAttempt(state, "review", 1);
    state = publishNodeOutput(state, "review", {
      private_output: "OUTPUT_SECRET",
      "ghp_abcdefghijklmnopqrstuvwxyz123456": true
    });
    state = failNode(state, "review", "PRIVATE_ERROR_REFERENCE");
    state = { ...state, run_status: "failed" };

    const outcome = projectStoredRunGraphOutcome({
      graphSnapshot: snapshot,
      recordRevision: 4,
      state
    });

    expect(outcome.nodes).toEqual([
      {
        node_id: "review",
        status: "failed",
        attempt_count: 1,
        observed_output: {
          redaction: "values_removed",
          truncated: false,
          fields: [
            { path: [], value_type: "object" },
            { path: ["private_output"], value_type: "string" },
            { path: ["<redacted>"], value_type: "boolean" }
          ]
        }
      }
    ]);
    expect(outcome.nodes).not.toContainEqual(
      expect.objectContaining({ node_id: "publish" })
    );
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("INVOCATION_SECRET");
    expect(serialized).not.toContain("CONFIG_SECRET");
    expect(serialized).not.toContain("OUTPUT_SECRET");
    expect(serialized).not.toContain("PRIVATE_ERROR_REFERENCE");
    expect(serialized).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(StoredRunGraphOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it("rejects unknown runtime nodes instead of inventing graph entries", () => {
    const snapshot = projectStoredRunGraphSnapshot({
      identity: identity(),
      compiled: compiled()
    });
    const state = createInitialRuntimeState({
      invocation: {},
      config: {},
      run: {
        run_id: "run-graph-1",
        workflow_id: "code-review",
        attempt: 1,
        started_at: "2026-07-11T10:00:00.000Z"
      },
      workflow: { id: "code-review" }
    });

    expect(() =>
      projectStoredRunGraphOutcome({
        graphSnapshot: snapshot,
        recordRevision: 2,
        state: {
          ...state,
          node_statuses: { intruder: { status: "succeeded" } }
        }
      })
    ).toThrow("unknown graph node");
  });

  it("bounds observed output traversal for wide objects", () => {
    const snapshot = projectStoredRunGraphSnapshot({ identity: identity(), compiled: compiled() });
    let state = createInitialRuntimeState({
      invocation: {},
      config: {},
      run: {
        run_id: "run-graph-1",
        workflow_id: "code-review",
        attempt: 1,
        started_at: "2026-07-11T10:00:00.000Z"
      },
      workflow: { id: "code-review" }
    });
    state = startNodeAttempt(state, "review", 1);
    state = publishNodeOutput(state, "review", Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`field_${index}`, index])
    ));
    state = { ...state, run_status: "succeeded" };

    const outcome = projectStoredRunGraphOutcome({ graphSnapshot: snapshot, recordRevision: 2, state });
    expect(outcome.nodes[0]?.observed_output?.truncated).toBe(true);
    expect(outcome.nodes[0]?.observed_output?.fields).toHaveLength(256);
  });

  it("rejects non-terminal and inconsistent attempt outcomes", () => {
    const snapshot = projectStoredRunGraphSnapshot({
      identity: identity(),
      compiled: compiled()
    });
    let state = createInitialRuntimeState({
      invocation: {},
      config: {},
      run: {
        run_id: "run-graph-1",
        workflow_id: "code-review",
        attempt: 1,
        started_at: "2026-07-11T10:00:00.000Z"
      },
      workflow: { id: "code-review" }
    });
    state = startNodeAttempt(state, "review", 1);

    expect(() =>
      projectStoredRunGraphOutcome({
        graphSnapshot: snapshot,
        recordRevision: 2,
        state
      })
    ).toThrow();

    expect(() =>
      projectStoredRunGraphOutcome({
        graphSnapshot: snapshot,
        recordRevision: 2,
        state: {
          ...state,
          run_status: "cancelled",
          node_statuses: {
            review: { ...state.node_statuses.review, attempt: 2 }
          }
        }
      })
    ).toThrow("attempt count is inconsistent");
  });

  it("keeps the endpoint contract strict and free of private fields", () => {
    const snapshot = projectStoredRunGraphSnapshot({
      identity: identity(),
      compiled: compiled()
    });
    const response = {
      schema_version: 1,
      availability: "available",
      run: {
        run_id: "run-graph-1",
        workflow_id: "code-review",
        workflow_revision: DIGEST_A,
        definition_bundle_hash: DIGEST_B,
        execution_snapshot_hash: DIGEST_D,
        status: "running",
        completeness: "complete"
      },
      graph_hash: snapshot.graph_hash,
      graph: snapshot.graph,
      overlay: {
        observation: "unobservable",
        reason: "live_observer_unavailable"
      },
      private_job: { invocation: {}, config: {}, snapshot_path: "/private" }
    };

    expect(RunGraphResponseSchema.safeParse(response).success).toBe(false);
  });

  it("never accepts a graph handle from the browser execute contract", () => {
    expect(
      StudioRunExecuteRequestSchema.safeParse({
        confirmation_token: "A".repeat(43),
        idempotency_key: "launch-key",
        confirmation: {
          kind: "local_explicit",
          real_run_confirmed: true,
          listed_effects_confirmed: true
        },
        graph_snapshot_handle: HANDLE
      }).success
    ).toBe(false);
  });
});
