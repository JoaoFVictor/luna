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
  "pending",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled"
] as const;

export type LunaRunStatus = (typeof RUN_STATUSES)[number];

const NODE_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "interrupted"
] as const;

export type LunaNodeStatus = (typeof NODE_STATUSES)[number];

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

export type RuntimeReducerMetadata = {
  reducer: "append_only";
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
};

export type CreateInitialRuntimeStateOptions = {
  invocation: JsonValue;
  config: JsonValue;
  run: RunHandle;
  workflow: LunaWorkflowHandle;
  event_cursor?: string;
};

export const LUNA_RUNTIME_STATE_REDUCER_METADATA = {
  artifact_refs: { reducer: "append_only" },
  interrupt_refs: { reducer: "append_only" }
} as const satisfies Record<string, RuntimeReducerMetadata>;

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
  "event_cursor"
]);

const runStatuses = new Set<string>(RUN_STATUSES);
const nodeStatuses = new Set<string>(NODE_STATUSES);
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
      !Number.isFinite(attempt.count)
    ) {
      invalidState(`Runtime state ${path}.count must be a finite number`, {
        path: `${path}.count`
      });
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
    run_status: "pending",
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

export function validateCheckpointState(state: unknown): void {
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
