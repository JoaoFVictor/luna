import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  assertCheckpointJsonValue,
  type JsonValue
} from "../../../src/core/runtime/json.js";
import {
  createInitialRuntimeState,
  LUNA_RUNTIME_STATE_REDUCER_METADATA,
  publishNodeOutput,
  validateCheckpointState,
  validateCheckpointStateSize,
  type LunaNodeStatus
} from "../../../src/core/runtime/state.js";

const invocation = {
  version: "2026-06",
  source: "github",
  event: "pull_request",
  target: { type: "workflow", id: "code-review" }
} satisfies JsonValue;

const config = {
  repository_id: "luna"
} satisfies JsonValue;

const run = {
  run_id: "run-1",
  workflow_id: "code-review",
  attempt: 1,
  started_at: "2026-06-25T12:00:00.000Z"
};

const workflow = {
  id: "code-review",
  mode: "read_only"
} as const;

function initialState() {
  return createInitialRuntimeState({
    invocation,
    config,
    run,
    workflow
  });
}

describe("runtime state contract", () => {
  it("creates initial JSON-serializable runtime state with public outputs under steps only", () => {
    const state = initialState();

    expect(state).toEqual({
      state_schema_version: "2026-06",
      invocation,
      config,
      run,
      workflow,
      run_status: "running",
      node_statuses: {},
      steps: {},
      attempts: {},
      artifact_refs: [],
      interrupt_refs: []
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(state).not.toHaveProperty("outputs");
    expect(state).not.toHaveProperty("artifacts");
    expect(state).not.toHaveProperty("interrupts");
    expect(state).not.toHaveProperty("events");
  });

  it.each([
    ["non-finite number", Number.POSITIVE_INFINITY],
    ["function", () => "nope"],
    ["symbol", Symbol("nope")],
    ["bigint", 1n],
    ["file-like object", new Date("2026-06-25T12:00:00.000Z")],
    ["buffer", Buffer.from("nope")]
  ])("rejects %s in checkpoint JSON", (_label, value) => {
    expect(() =>
      assertCheckpointJsonValue({
        ok: true,
        value
      })
    ).toThrow(expect.objectContaining({ code: "runtime_invalid_json" }));
  });

  it("rejects cyclic checkpoint JSON", () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(() => assertCheckpointJsonValue(value)).toThrow(
      expect.objectContaining({ code: "runtime_invalid_json" })
    );
  });

  it("rejects oversized checkpoint payloads", () => {
    expect(() =>
      validateCheckpointStateSize({ payload: "x".repeat(20) }, { maxBytes: 16 })
    ).toThrow(expect.objectContaining({ code: "runtime_checkpoint_too_large" }));
  });

  it("rejects structured node error envelopes as successful node output", () => {
    const state = initialState();

    expect(() =>
      publishNodeOutput(state, "review", {
        ok: false,
        error: {
          code: "agent_failed",
          message: "agent failed"
        }
      })
    ).toThrow(
      expect.objectContaining({ code: "runtime_node_output_error_envelope" })
    );
    expect(state.steps).toEqual({});
  });

  it("keeps artifacts, interrupts, and event progress as refs or cursors only", () => {
    const state = createInitialRuntimeState({
      invocation,
      config,
      run,
      workflow,
      event_cursor: "events:42"
    });

    state.artifact_refs.push({
      id: "artifact-1",
      uri: "luna://run-1/artifacts/context.json",
      node_id: "context"
    });
    state.interrupt_refs.push({
      id: "interrupt-1",
      uri: "interrupt://run-1/review"
    });

    expect(() => validateCheckpointState(state)).not.toThrow();

    expect(() =>
      validateCheckpointState({
        ...state,
        artifact_refs: [
          ...state.artifact_refs,
          {
            id: "artifact-2",
            uri: "luna://run-1/artifacts/payload.json",
            payload: { too_much: true }
          }
        ]
      })
    ).toThrow(expect.objectContaining({ code: "runtime_state_ref_payload" }));

    expect(() =>
      validateCheckpointState({
        ...state,
        interrupt_refs: [
          ...state.interrupt_refs,
          {
            id: "interrupt-2",
            uri: "interrupt://run-1/approval",
            value: { approved: false }
          }
        ]
      })
    ).toThrow(expect.objectContaining({ code: "runtime_state_ref_payload" }));

    expect(() =>
      validateCheckpointState({
        ...state,
        artifact_refs: [
          ...state.artifact_refs,
          {
            id: "artifact-3",
            uri: "luna://run-1/artifacts/contents.json",
            contents: "hidden payload"
          }
        ]
      })
    ).toThrow(expect.objectContaining({ code: "runtime_state_ref_payload" }));

    expect(() =>
      validateCheckpointState({
        ...state,
        artifact_refs: [
          ...state.artifact_refs,
          {
            id: "artifact-4",
            uri: "luna://run-1/artifacts/bad-node.json",
            node_id: 123
          }
        ]
      })
    ).toThrow(expect.objectContaining({ code: "runtime_state_ref_payload" }));

    expect(() =>
      validateCheckpointState({
        ...state,
        event_cursor: {
          offset: 42
        }
      })
    ).toThrow(expect.objectContaining({ code: "runtime_state_ref_payload" }));
  });

  it("rejects duplicate public node output publication", () => {
    const state = initialState();

    const next = publishNodeOutput(state, "context", { files: [] });

    expect(next.steps.context).toEqual({ files: [] });
    expect(() => publishNodeOutput(next, "context", { files: ["again"] })).toThrow(
      expect.objectContaining({ code: "runtime_duplicate_node_output" })
    );
  });

  it.each([
    "failed",
    "skipped_inactive",
    "skipped_dependency_failed",
    "cancelled",
    "timed_out",
    "waiting_for_input"
  ] satisfies LunaNodeStatus[])(
    "rejects successful output publication for %s nodes",
    (status) => {
      const state = {
        ...initialState(),
        node_statuses: {
          review: { status }
        }
      };

      expect(() => publishNodeOutput(state, "review", { ok: true })).toThrow(
        expect.objectContaining({ code: "runtime_node_output_status_invalid" })
      );
    }
  );

  it("describes append-only reducers as explicit compiler metadata", () => {
    expect(LUNA_RUNTIME_STATE_REDUCER_METADATA).toEqual({
      artifact_refs: { reducer: "append_only" },
      interrupt_refs: { reducer: "append_only" }
    });
  });

  it.each([
    "state_schema_version",
    "invocation",
    "config",
    "run",
    "workflow",
    "run_status",
    "node_statuses",
    "steps",
    "attempts",
    "artifact_refs",
    "interrupt_refs"
  ])("rejects checkpoint state missing required key %s", (key) => {
    const state = initialState() as Record<string, unknown>;
    delete state[key];

    expect(() => validateCheckpointState(state)).toThrow(
      expect.objectContaining({ code: "runtime_state_invalid" })
    );
  });

  it.each([
    ["state schema version", { state_schema_version: "2025-01" }],
    ["run status", { run_status: "done" }],
    ["run handle", { run: { run_id: "run-1", workflow_id: "code-review" } }],
    ["run attempt", { run: { ...run, attempt: "1" } }],
    ["workflow handle", { workflow: { mode: "read_only" } }],
    ["node status map", { node_statuses: [] }],
    ["node status entry", { node_statuses: { review: { status: "done" } } }],
    ["steps map", { steps: [] }],
    ["attempts map", { attempts: [] }],
    ["attempt count", { attempts: { review: { count: "1", history: [] } } }],
    ["attempt history", { attempts: { review: { count: 1, history: [] } } }],
    [
      "attempt status",
      {
        attempts: {
          review: {
            count: 1,
            history: [
              {
                attempt: 1,
                status: "waiting",
                started_at: "2026-06-25T12:00:00.000Z"
              }
            ]
          }
        }
      }
    ],
    [
      "primary failure",
      { primary_failure: { node_id: "review", status: "skipped_inactive" } }
    ]
  ])("rejects invalid %s in checkpoint state", (_label, patch) => {
    expect(() =>
      validateCheckpointState({
        ...initialState(),
        ...patch
      })
    ).toThrow(expect.objectContaining({ code: "runtime_state_invalid" }));
  });

  it.each(["outputs", "artifacts", "interrupts", "events"])(
    "rejects forbidden top-level public payload container %s",
    (key) => {
      expect(() =>
        validateCheckpointState({
          ...initialState(),
          [key]: {}
        })
      ).toThrow(expect.objectContaining({ code: "runtime_state_public_payload" }));
    }
  );

  it("rejects arbitrary unknown top-level state keys", () => {
    expect(() =>
      validateCheckpointState({
        ...initialState(),
        cache: {}
      })
    ).toThrow(expect.objectContaining({ code: "runtime_state_invalid" }));
  });

  it("rejects structured error envelopes already present in step outputs", () => {
    expect(() =>
      validateCheckpointState({
        ...initialState(),
        steps: {
          review: {
            ok: false,
            error: {
              code: "agent_failed",
              message: "agent failed"
            }
          }
        }
      })
    ).toThrow(
      expect.objectContaining({ code: "runtime_node_output_error_envelope" })
    );
  });
});
