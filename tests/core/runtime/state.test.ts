import { describe, expect, it } from "vitest";
import { type JsonValue } from "../../../src/core/runtime/json.js";
import {
  createInitialRuntimeState,
  publishNodeOutput,
  validateCheckpointState
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

  it("rejects successful output publication for failed nodes", () => {
    const state = {
      ...initialState(),
      node_statuses: {
        review: { status: "failed" as const }
      }
    };

    expect(() => publishNodeOutput(state, "review", { ok: true })).toThrow(
      expect.objectContaining({ code: "runtime_node_output_status_invalid" })
    );
  });

});
