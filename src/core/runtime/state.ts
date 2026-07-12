import {
  assertCheckpointJsonObject,
  assertCheckpointJsonSize,
  assertCheckpointJsonValue,
  isCheckpointPlainObject,
  type CheckpointSizeOptions,
  type JsonObject,
  type JsonValue
} from "./json.js";
import type { RunHandle } from "./run-handle.js";
import { runtimeError } from "./errors.js";

export const LUNA_RUNTIME_STATE_SCHEMA_VERSION = "2026-06";

const RUN_STATUSES = [
  "running",
  "waiting_for_input",
  "waiting_for_retry",
  "resuming",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled"
] as const;

export type LunaRunStatus = (typeof RUN_STATUSES)[number];

const NODE_STATUSES = [
  "pending",
  "running",
  "waiting_for_input",
  "succeeded",
  "failed",
  "skipped_inactive",
  "skipped_dependency_failed",
  "cancelled",
  "timed_out"
] as const;

export type LunaNodeStatus = (typeof NODE_STATUSES)[number];

const ATTEMPT_STATUSES = [
  "started",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out"
] as const;

export type LunaAttemptStatus = (typeof ATTEMPT_STATUSES)[number];

const WORKFLOW_MODES = ["read_only", "trusted_local_write"] as const;

export type LunaWorkflowMode = (typeof WORKFLOW_MODES)[number];

export type LunaWorkflowHandle = JsonObject & {
  id: string;
  mode?: LunaWorkflowMode;
};

export type RuntimeNodeStatus = JsonObject & {
  status: LunaNodeStatus;
  attempt?: number;
  started_at?: string;
  completed_at?: string;
  error_ref?: string;
};

export type RuntimeAttemptState = JsonObject & {
  count: number;
  history: RuntimeAttemptRecord[];
};

export type RuntimeAttemptRecord = JsonObject & {
  attempt: number;
  status: LunaAttemptStatus;
  started_at: string;
  completed_at?: string;
  error_ref?: string;
};

export type RuntimeArtifactRef = {
  id: string;
  uri: string;
  node_id?: string;
};

export type RuntimeInterruptRef = {
  id: string;
  uri: string;
  node_id?: string;
};

export type RuntimePrimaryFailure = JsonObject & {
  node_id: string;
  status: Extract<LunaNodeStatus, "failed" | "timed_out">;
  error_ref?: string;
};

export type RuntimeReducerMetadata = {
  reducer: "append_only" | "object_merge";
};

export type LunaRuntimeState = {
  state_schema_version: typeof LUNA_RUNTIME_STATE_SCHEMA_VERSION;
  invocation: JsonValue;
  config: JsonValue;
  run: RunHandle;
  workflow: LunaWorkflowHandle;
  run_status: LunaRunStatus;
  node_statuses: Record<string, RuntimeNodeStatus>;
  steps: Record<string, JsonValue>;
  attempts: Record<string, RuntimeAttemptState>;
  artifact_refs: RuntimeArtifactRef[];
  interrupt_refs: RuntimeInterruptRef[];
  event_cursor?: string;
  primary_failure?: RuntimePrimaryFailure;
};

export const LUNA_RUNTIME_STATE_CHANNELS = {
  node_statuses: { reducer: "object_merge" },
  steps: { reducer: "object_merge" },
  attempts: { reducer: "object_merge" },
  artifact_refs: { reducer: "append_only" },
  interrupt_refs: { reducer: "append_only" }
} as const satisfies Record<string, RuntimeReducerMetadata>;

/**
 * Every key registered as a LangGraph state channel. Public workflow node ids
 * must not reuse these names because StateGraph shares one node/channel
 * namespace.
 */
export const LUNA_RUNTIME_STATE_FIELD_NAMES = [
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
  "interrupt_refs",
  "event_cursor",
  "primary_failure"
] as const;

export type CreateInitialRuntimeStateOptions = {
  invocation: JsonValue;
  config: JsonValue;
  run: RunHandle;
  workflow: LunaWorkflowHandle;
  event_cursor?: string;
};

export const LUNA_RUNTIME_STATE_REDUCER_METADATA = LUNA_RUNTIME_STATE_CHANNELS;

const requiredStateKeys = [
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
] as const;

const allowedStateKeys = new Set<string>([
  ...requiredStateKeys,
  "event_cursor",
  "primary_failure"
]);

const runStatuses = new Set<string>(RUN_STATUSES);
const nodeStatuses = new Set<string>(NODE_STATUSES);
const attemptStatuses = new Set<string>(ATTEMPT_STATUSES);
const workflowModes = new Set<string>(WORKFLOW_MODES);
const allowedRefKeys = new Set(["id", "uri", "node_id"]);

const forbiddenTopLevelPayloadKeys = new Set([
  "outputs",
  "artifacts",
  "interrupts",
  "events"
]);

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidState(
  message: string,
  details: Record<string, unknown> = {}
): never {
  throw runtimeError(message, "runtime_state_invalid", { details });
}

function assertPlainObjectMap(
  value: unknown,
  path: string
): asserts value is Record<string, JsonValue> {
  if (!isCheckpointPlainObject(value)) {
    invalidState(`Runtime state ${path} must be a plain object map`, { path });
  }
}

function assertOptionalString(
  value: JsonObject,
  key: string,
  path: string
): void {
  if (hasOwn(value, key) && typeof value[key] !== "string") {
    invalidState(`Runtime state ${path}.${key} must be a string`, {
      path: `${path}.${key}`
    });
  }
}

function assertOptionalFiniteNumber(
  value: JsonObject,
  key: string,
  path: string
): void {
  if (
    hasOwn(value, key) &&
    (typeof value[key] !== "number" || !Number.isFinite(value[key]))
  ) {
    invalidState(`Runtime state ${path}.${key} must be a finite number`, {
      path: `${path}.${key}`
    });
  }
}

function assertRunHandle(value: unknown): asserts value is RunHandle {
  if (!isCheckpointPlainObject(value)) {
    invalidState("Runtime state run must be a plain object", { path: "$.run" });
  }

  for (const key of ["run_id", "workflow_id", "started_at"]) {
    if (typeof value[key] !== "string") {
      invalidState(`Runtime state run.${key} must be a string`, {
        path: `$.run.${key}`
      });
    }
  }

  if (typeof value.attempt !== "number" || !Number.isFinite(value.attempt)) {
    invalidState("Runtime state run.attempt must be a finite number", {
      path: "$.run.attempt"
    });
  }
}

function assertWorkflowHandle(value: unknown): asserts value is LunaWorkflowHandle {
  if (!isCheckpointPlainObject(value)) {
    invalidState("Runtime state workflow must be a plain object", {
      path: "$.workflow"
    });
  }

  if (typeof value.id !== "string") {
    invalidState("Runtime state workflow.id must be a string", {
      path: "$.workflow.id"
    });
  }

  if (
    hasOwn(value, "mode") &&
    (typeof value.mode !== "string" || !workflowModes.has(value.mode))
  ) {
    invalidState("Runtime state workflow.mode is invalid", {
      path: "$.workflow.mode"
    });
  }
}

function assertNodeStatusMap(value: unknown): void {
  assertPlainObjectMap(value, "$.node_statuses");

  for (const [nodeId, status] of Object.entries(value)) {
    const path = `$.node_statuses.${nodeId}`;

    if (!isCheckpointPlainObject(status)) {
      invalidState(`Runtime state ${path} must be a plain object`, { path });
    }

    if (
      typeof status.status !== "string" ||
      !nodeStatuses.has(status.status)
    ) {
      invalidState(`Runtime state ${path}.status is invalid`, {
        path: `${path}.status`
      });
    }

    assertOptionalFiniteNumber(status, "attempt", path);
    assertOptionalString(status, "started_at", path);
    assertOptionalString(status, "completed_at", path);
    assertOptionalString(status, "error_ref", path);
  }
}

function assertStepsMap(value: unknown): void {
  assertPlainObjectMap(value, "$.steps");

  for (const [nodeId, output] of Object.entries(value)) {
    if (isStructuredErrorEnvelope(output)) {
      throw runtimeError(
        `Node output for ${nodeId} is a structured error envelope`,
        "runtime_node_output_error_envelope",
        { details: { node_id: nodeId } }
      );
    }
  }
}

function assertAttemptsMap(value: unknown): void {
  assertPlainObjectMap(value, "$.attempts");

  for (const [nodeId, attempt] of Object.entries(value)) {
    const path = `$.attempts.${nodeId}`;

    if (!isCheckpointPlainObject(attempt)) {
      invalidState(`Runtime state ${path} must be a plain object`, { path });
    }

    if (
      typeof attempt.count !== "number" ||
      !Number.isSafeInteger(attempt.count) ||
      attempt.count < 0
    ) {
      invalidState(`Runtime state ${path}.count must be a non-negative integer`, {
        path: `${path}.count`
      });
    }

    if (!Array.isArray(attempt.history)) {
      invalidState(`Runtime state ${path}.history must be an array`, {
        path: `${path}.history`
      });
    }

    if (attempt.history.length !== attempt.count) {
      invalidState(`Runtime state ${path}.history length must match count`, {
        path: `${path}.history`
      });
    }

    let previousAttempt = 0;
    for (const [index, record] of attempt.history.entries()) {
      const recordPath = `${path}.history[${index}]`;

      if (!isCheckpointPlainObject(record)) {
        invalidState(`Runtime state ${recordPath} must be a plain object`, {
          path: recordPath
        });
      }

      if (
        typeof record.attempt !== "number" ||
        !Number.isSafeInteger(record.attempt) ||
        record.attempt < 1
      ) {
        invalidState(
          `Runtime state ${recordPath}.attempt must be a positive integer`,
          { path: `${recordPath}.attempt` }
        );
      }

      if (record.attempt <= previousAttempt) {
        invalidState(`Runtime state ${recordPath}.attempt must increase`, {
          path: `${recordPath}.attempt`
        });
      }
      previousAttempt = record.attempt;

      if (
        typeof record.status !== "string" ||
        !attemptStatuses.has(record.status)
      ) {
        invalidState(`Runtime state ${recordPath}.status is invalid`, {
          path: `${recordPath}.status`
        });
      }

      if (typeof record.started_at !== "string") {
        invalidState(`Runtime state ${recordPath}.started_at must be a string`, {
          path: `${recordPath}.started_at`
        });
      }

      assertOptionalString(record, "completed_at", recordPath);
      assertOptionalString(record, "error_ref", recordPath);
    }
  }
}

function rejectUnknownRefKeys(
  ref: JsonObject,
  collectionName: "artifact_refs" | "interrupt_refs",
  index: number
): void {
  for (const key of Object.keys(ref)) {
    if (allowedRefKeys.has(key)) {
      continue;
    }

    throw runtimeError(
      `Runtime state ${collectionName}[${index}] contains non-ref key: ${key}`,
      "runtime_state_ref_payload",
      {
        details: {
          collection: collectionName,
          index,
          key
        }
      }
    );
  }
}

function assertRefCollection(
  value: unknown,
  collectionName: "artifact_refs" | "interrupt_refs"
): void {
  if (!Array.isArray(value)) {
    throw runtimeError(
      `Runtime state ${collectionName} must be an array of refs`,
      "runtime_state_ref_payload",
      { details: { collection: collectionName } }
    );
  }

  value.forEach((ref, index) => {
    assertCheckpointJsonObject(ref, `$.${collectionName}[${index}]`);

    if (typeof ref.id !== "string" || typeof ref.uri !== "string") {
      throw runtimeError(
        `Runtime state ${collectionName}[${index}] must contain id and uri refs`,
        "runtime_state_ref_payload",
        {
          details: {
            collection: collectionName,
            index
          }
        }
      );
    }

    if (hasOwn(ref, "node_id") && typeof ref.node_id !== "string") {
      throw runtimeError(
        `Runtime state ${collectionName}[${index}].node_id must be a string`,
        "runtime_state_ref_payload",
        {
          details: {
            collection: collectionName,
            index,
            key: "node_id"
          }
        }
      );
    }

    rejectUnknownRefKeys(ref, collectionName, index);
  });
}

function assertPrimaryFailure(value: unknown): void {
  if (value === undefined) {
    return;
  }

  if (!isCheckpointPlainObject(value)) {
    invalidState("Runtime state primary_failure must be a plain object", {
      path: "$.primary_failure"
    });
  }

  if (typeof value.node_id !== "string") {
    invalidState("Runtime state primary_failure.node_id must be a string", {
      path: "$.primary_failure.node_id"
    });
  }

  if (
    value.status !== "failed" &&
    value.status !== "timed_out"
  ) {
    invalidState("Runtime state primary_failure.status is invalid", {
      path: "$.primary_failure.status"
    });
  }

  assertOptionalString(value, "error_ref", "$.primary_failure");
}

function isStructuredErrorEnvelope(value: JsonValue): boolean {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.ok !== false ||
    typeof value.error !== "object" ||
    value.error === null ||
    Array.isArray(value.error)
  ) {
    return false;
  }

  return (
    typeof value.error.code === "string" ||
    typeof value.error.message === "string"
  );
}

function assertNodeCanPublishOutput(
  state: LunaRuntimeState,
  nodeId: string
): void {
  const status = state.node_statuses[nodeId]?.status;

  if (
    status === "failed" ||
    status === "skipped_inactive" ||
    status === "skipped_dependency_failed" ||
    status === "cancelled" ||
    status === "timed_out" ||
    status === "waiting_for_input"
  ) {
    throw runtimeError(
      `Node output cannot be published for ${nodeId} with status ${status}`,
      "runtime_node_output_status_invalid",
      { details: { node_id: nodeId, status } }
    );
  }
}

export function createInitialRuntimeState({
  invocation,
  config,
  run,
  workflow,
  event_cursor
}: CreateInitialRuntimeStateOptions): LunaRuntimeState {
  assertCheckpointJsonValue(invocation, "$.invocation");
  assertCheckpointJsonValue(config, "$.config");
  assertCheckpointJsonObject(run, "$.run");
  assertCheckpointJsonObject(workflow, "$.workflow");

  const state: LunaRuntimeState = {
    state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION,
    invocation,
    config,
    run,
    workflow,
    run_status: "running",
    node_statuses: {},
    steps: {},
    attempts: {},
    artifact_refs: [],
    interrupt_refs: [],
    ...(event_cursor === undefined ? {} : { event_cursor })
  };

  validateCheckpointState(state);

  return state;
}

export function validateCheckpointStateSize(
  state: unknown,
  options: CheckpointSizeOptions
): void {
  assertCheckpointJsonSize(state, options);
}

export function validateCheckpointState(
  state: unknown
): asserts state is LunaRuntimeState {
  assertCheckpointJsonObject(state);

  for (const key of requiredStateKeys) {
    if (!hasOwn(state, key)) {
      invalidState(`Runtime state is missing required key: ${key}`, { key });
    }
  }

  for (const key of forbiddenTopLevelPayloadKeys) {
    if (hasOwn(state, key)) {
      throw runtimeError(
        `Runtime state must not expose top-level payload container: ${key}`,
        "runtime_state_public_payload",
        { details: { key } }
      );
    }
  }

  for (const key of Object.keys(state)) {
    if (!allowedStateKeys.has(key)) {
      invalidState(`Runtime state contains unknown top-level key: ${key}`, {
        key
      });
    }
  }

  if (state.state_schema_version !== LUNA_RUNTIME_STATE_SCHEMA_VERSION) {
    invalidState("Runtime state schema version is invalid", {
      path: "$.state_schema_version",
      expected: LUNA_RUNTIME_STATE_SCHEMA_VERSION
    });
  }

  assertRunHandle(state.run);
  assertWorkflowHandle(state.workflow);

  if (
    typeof state.run_status !== "string" ||
    !runStatuses.has(state.run_status)
  ) {
    invalidState("Runtime state run_status is invalid", {
      path: "$.run_status"
    });
  }

  assertNodeStatusMap(state.node_statuses);
  assertStepsMap(state.steps);
  assertAttemptsMap(state.attempts);
  assertRefCollection(state.artifact_refs, "artifact_refs");
  assertRefCollection(state.interrupt_refs, "interrupt_refs");
  assertPrimaryFailure(state.primary_failure);

  if (
    Object.prototype.hasOwnProperty.call(state, "event_cursor") &&
    typeof state.event_cursor !== "string"
  ) {
    throw runtimeError(
      "Runtime state event_cursor must store only a cursor string",
      "runtime_state_ref_payload",
      { details: { key: "event_cursor" } }
    );
  }
}

export function publishNodeOutput(
  state: LunaRuntimeState,
  nodeId: string,
  output: JsonValue
): LunaRuntimeState {
  assertNodeCanPublishOutput(state, nodeId);

  if (Object.prototype.hasOwnProperty.call(state.steps, nodeId)) {
    throw runtimeError(
      `Node output already exists for node: ${nodeId}`,
      "runtime_duplicate_node_output",
      { details: { node_id: nodeId } }
    );
  }

  assertCheckpointJsonValue(output, `$.steps.${nodeId}`);

  if (isStructuredErrorEnvelope(output)) {
    throw runtimeError(
      `Node output for ${nodeId} is a structured error envelope`,
      "runtime_node_output_error_envelope",
      { details: { node_id: nodeId } }
    );
  }

  return {
    ...state,
    steps: {
      ...state.steps,
      [nodeId]: output
    }
  };
}
