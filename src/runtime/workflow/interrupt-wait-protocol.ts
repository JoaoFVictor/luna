import type { CheckpointWriteRecord } from "../../core/runtime/backends/contracts.js";
import {
  isCheckpointPlainObject,
  type JsonObject,
  type JsonValue
} from "../../core/runtime/json.js";
import type {
  RuntimeArtifactRef,
  RuntimeInterruptRef
} from "../../core/runtime/state.js";
import { sha256Digest } from "../../core/workflow/definition-digests.js";
import {
  parseRuntimeReference
} from "./runtime-reference-codec.js";

export const WAIT_INTENT_SCHEMA_VERSION = 2;
export const WAIT_INTENT_CHANNEL = "interrupt_wait_intent";
export const WAIT_COMPLETION_CHANNEL = "interrupt_wait_completion";

export type InterruptWaitIntent = {
  readonly schema_version: typeof WAIT_INTENT_SCHEMA_VERSION;
  readonly run_id: string;
  readonly workflow_revision: string;
  readonly node_id: string;
  readonly capability_id: string;
  readonly checkpoint_id: string;
  readonly interrupt_id: string;
  readonly created_at: string;
  readonly artifact_refs: RuntimeArtifactRef[];
  readonly interrupt_refs: RuntimeInterruptRef[];
  readonly resume_context: JsonObject;
};

type WaitIdentityKind = "interrupt" | "checkpoint";

function legacyWaitIdentity(
  kind: WaitIdentityKind,
  runId: string,
  nodeId: string,
  occurrence?: string
): string {
  return `${kind}-${runId}-${nodeId}${occurrence === undefined ? "" : `-${occurrence}`}`;
}

function waitIdentity(
  kind: WaitIdentityKind,
  runId: string,
  nodeId: string,
  occurrence?: string
): string {
  if (occurrence === undefined) {
    return legacyWaitIdentity(kind, runId, nodeId);
  }
  const digest = sha256Digest({
    schema_version: 2,
    kind,
    run_id: runId,
    node_id: nodeId,
    occurrence
  }).slice("sha256:".length);
  return `${kind}-v2-${digest}`;
}

export function interruptId(runId: string, nodeId: string, occurrence?: string): string {
  return waitIdentity("interrupt", runId, nodeId, occurrence);
}

export function checkpointId(runId: string, nodeId: string, occurrence?: string): string {
  return waitIdentity("checkpoint", runId, nodeId, occurrence);
}

export function legacyInterruptId(
  runId: string,
  nodeId: string,
  occurrence?: string
): string {
  return legacyWaitIdentity("interrupt", runId, nodeId, occurrence);
}

export function legacyCheckpointId(
  runId: string,
  nodeId: string,
  occurrence?: string
): string {
  return legacyWaitIdentity("checkpoint", runId, nodeId, occurrence);
}

export function interruptIdMatches(
  value: string,
  runId: string,
  nodeId: string,
  occurrence?: string
): boolean {
  return value === interruptId(runId, nodeId, occurrence) ||
    (occurrence !== undefined && value === legacyInterruptId(runId, nodeId, occurrence));
}

export function checkpointIdCandidates(
  runId: string,
  nodeId: string,
  occurrence?: string
): readonly string[] {
  const current = checkpointId(runId, nodeId, occurrence);
  if (occurrence === undefined) return [current];
  return [current, legacyCheckpointId(runId, nodeId, occurrence)];
}

export function waitIntentTaskId(nodeId: string): string {
  return `__luna_wait_intent__:${nodeId}`;
}

export function waitCompletionTaskId(nodeId: string): string {
  return `__luna_wait_completion__:${nodeId}`;
}

export function parseInterruptWaitIntent(
  value: JsonValue,
  invalid: (details?: Record<string, unknown>) => Error
): InterruptWaitIntent {
  if (
    !isCheckpointPlainObject(value) ||
    value.schema_version !== WAIT_INTENT_SCHEMA_VERSION ||
    typeof value.run_id !== "string" ||
    value.run_id.length === 0 ||
    typeof value.workflow_revision !== "string" ||
    value.workflow_revision.length === 0 ||
    typeof value.node_id !== "string" ||
    value.node_id.length === 0 ||
    typeof value.capability_id !== "string" ||
    value.capability_id.length === 0 ||
    typeof value.checkpoint_id !== "string" ||
    value.checkpoint_id.length === 0 ||
    typeof value.interrupt_id !== "string" ||
    value.interrupt_id.length === 0 ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    !Array.isArray(value.artifact_refs) ||
    !Array.isArray(value.interrupt_refs) ||
    !isCheckpointPlainObject(value.resume_context) ||
    Object.keys(value).some(
      (key) => ![
        "schema_version",
        "run_id",
        "workflow_revision",
        "node_id",
        "capability_id",
        "checkpoint_id",
        "interrupt_id",
        "created_at",
        "artifact_refs",
        "interrupt_refs",
        "resume_context"
      ].includes(key)
    )
  ) {
    throw invalid();
  }

  return {
    schema_version: WAIT_INTENT_SCHEMA_VERSION,
    run_id: value.run_id,
    workflow_revision: value.workflow_revision,
    node_id: value.node_id,
    capability_id: value.capability_id,
    checkpoint_id: value.checkpoint_id,
    interrupt_id: value.interrupt_id,
    created_at: value.created_at,
    artifact_refs: value.artifact_refs.map((reference, index) =>
      parseRuntimeReference<RuntimeArtifactRef>(reference, () =>
        invalid({ artifact_index: index })
      )
    ),
    interrupt_refs: value.interrupt_refs.map((reference, index) =>
      parseRuntimeReference<RuntimeInterruptRef>(reference, () =>
        invalid({ interrupt_index: index })
      )
    ),
    resume_context: value.resume_context
  };
}

export function waitIntentWrite(
  intent: InterruptWaitIntent
): CheckpointWriteRecord {
  return {
    thread_id: intent.run_id,
    checkpoint_ns: "",
    checkpoint_id: intent.checkpoint_id,
    task_id: waitIntentTaskId(intent.node_id),
    index: 0,
    channel: WAIT_INTENT_CHANNEL,
    value: intent
  };
}

export function waitCompletionWrite(
  intent: InterruptWaitIntent
): CheckpointWriteRecord {
  return {
    thread_id: intent.run_id,
    checkpoint_ns: "",
    checkpoint_id: intent.checkpoint_id,
    task_id: waitCompletionTaskId(intent.node_id),
    index: 0,
    channel: WAIT_COMPLETION_CHANNEL,
    value: {
      schema_version: WAIT_INTENT_SCHEMA_VERSION,
      created_at: intent.created_at,
      interrupt_id: intent.interrupt_id
    }
  };
}
