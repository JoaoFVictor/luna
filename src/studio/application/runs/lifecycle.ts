import {
  RunRecordSchema,
  RunTerminalStatusSchema,
  type RunDisplayStatus,
  type RunRecord,
  type RunRuntimeStatus
} from "../../contracts/runs.js";
import {
  PreallocateRunInputSchema,
  RunTransitionSchema,
  type PreallocateRunInput,
  type RunTransition
} from "./ports.js";
import { runStoreError } from "./errors.js";
import { parseRunContract } from "./validation.js";

const ALLOWED_RUNTIME_TRANSITIONS: Readonly<
  Record<RunRuntimeStatus, readonly RunRuntimeStatus[]>
> = {
  running: [
    "waiting_for_input",
    "waiting_for_retry",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled"
  ],
  waiting_for_input: ["resuming", "failed", "timed_out", "cancelled"],
  waiting_for_retry: ["resuming", "failed", "timed_out", "cancelled"],
  resuming: [
    "running",
    "waiting_for_input",
    "waiting_for_retry",
    "failed",
    "timed_out",
    "cancelled"
  ],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: []
};

export function initialRunRecord(input: PreallocateRunInput): RunRecord {
  const command = parseRunContract(PreallocateRunInputSchema, input, "ledger command");
  return RunRecordSchema.parse({
    schema_version: 1,
    record_revision: 1,
    run_id: command.run_id,
    ...(command.correlation_id === undefined ? {} : { correlation_id: command.correlation_id }),
    ...(command.job_id === undefined ? {} : { job_id: command.job_id }),
    workflow_id: command.workflow_id,
    ...command.definition,
    dispatch_status: "queued",
    created_at: command.created_at,
    updated_at: command.created_at,
    ...(command.source === undefined ? {} : { source: command.source }),
    ...(command.subject === undefined ? {} : { subject: command.subject }),
    ...(command.repository_id === undefined ? {} : { repository_id: command.repository_id }),
    active_node_ids: [],
    ...(command.graph_snapshot_handle === undefined
      ? {}
      : { graph_snapshot_handle: command.graph_snapshot_handle }),
    artifact_count: 0,
    interrupt_count: 0,
    side_effects: command.side_effects,
    completeness: "complete"
  });
}

function isTerminal(record: RunRecord): boolean {
  return record.dispatch_status === "rejected" ||
    (record.run_status !== undefined &&
      RunTerminalStatusSchema.safeParse(record.run_status).success);
}

function assertMutable(record: RunRecord): void {
  if (isTerminal(record)) {
    throw runStoreError(
      "run_terminal_immutable",
      "Terminal run records cannot be changed",
      { run_id: record.run_id, revision: record.record_revision }
    );
  }
}

function assertMonotonicTime(record: RunRecord, occurredAt: string): void {
  if (Date.parse(occurredAt) < Date.parse(record.updated_at)) {
    throw runStoreError(
      "run_transition_invalid",
      "Run transition time cannot move backwards",
      { run_id: record.run_id, revision: record.record_revision }
    );
  }
}

function assertOwner(record: RunRecord, ownerId: string): void {
  if (record.owner_id !== ownerId) {
    throw runStoreError("run_owner_conflict", "Run owner does not match", {
      run_id: record.run_id,
      revision: record.record_revision
    });
  }
}

function assertUniqueNodes(nodeIds: readonly string[]): void {
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw runStoreError(
      "run_transition_invalid",
      "Active node ids must be unique"
    );
  }
}

function monotonicCount(
  current: number,
  candidate: number | undefined,
  field: string
): number {
  if (candidate === undefined) {
    return current;
  }
  if (candidate < current) {
    throw runStoreError(
      "run_transition_invalid",
      `${field} cannot decrease`
    );
  }
  return candidate;
}

function nextRevision(record: RunRecord): number {
  const revision = record.record_revision + 1;
  if (!Number.isSafeInteger(revision)) {
    throw runStoreError("run_transition_invalid", "Run revision is exhausted", {
      run_id: record.run_id,
      revision: record.record_revision
    });
  }
  return revision;
}

function withoutTerminalDetails(record: RunRecord): RunRecord {
  const copy = { ...record };
  delete copy.failed_node_id;
  delete copy.failure;
  delete copy.finished_at;
  return copy;
}

function preparing(
  record: RunRecord,
  transition: Extract<RunTransition, { kind: "dispatch_preparing" }>,
  occurredAt: string
): RunRecord {
  if (record.dispatch_status !== "queued") {
    throw runStoreError("run_transition_invalid", "Only queued runs can be prepared");
  }
  return {
    ...record,
    record_revision: nextRevision(record),
    dispatch_status: "preparing",
    owner_id: transition.owner_id,
    owner_claimed_at: occurredAt,
    heartbeat_at: occurredAt,
    updated_at: occurredAt
  };
}

function started(
  record: RunRecord,
  transition: Extract<RunTransition, { kind: "dispatch_started" }>,
  occurredAt: string
): RunRecord {
  if (record.dispatch_status !== "preparing") {
    throw runStoreError("run_transition_invalid", "Only prepared runs can start");
  }
  assertOwner(record, transition.owner_id);
  assertUniqueNodes(transition.active_node_ids);
  return {
    ...record,
    record_revision: nextRevision(record),
    dispatch_status: "started",
    run_status: "running",
    started_at: occurredAt,
    heartbeat_at: occurredAt,
    active_node_ids: transition.active_node_ids,
    updated_at: occurredAt
  };
}

function rejected(
  record: RunRecord,
  transition: Extract<RunTransition, { kind: "dispatch_rejected" }>,
  occurredAt: string
): RunRecord {
  if (record.dispatch_status !== "queued" && record.dispatch_status !== "preparing") {
    throw runStoreError("run_transition_invalid", "Only pending dispatches can be rejected");
  }
  if (record.dispatch_status === "preparing") {
    if (transition.owner_id === undefined) {
      throw runStoreError("run_owner_conflict", "Prepared run rejection requires its owner");
    }
    assertOwner(record, transition.owner_id);
  } else if (transition.owner_id !== undefined) {
    throw runStoreError("run_owner_conflict", "Queued run has no owner");
  }
  return {
    ...record,
    record_revision: nextRevision(record),
    dispatch_status: "rejected",
    finished_at: occurredAt,
    failure: transition.failure,
    updated_at: occurredAt
  };
}

function heartbeat(
  record: RunRecord,
  transition: Extract<RunTransition, { kind: "heartbeat" }>,
  occurredAt: string
): RunRecord {
  if (record.dispatch_status !== "preparing" && record.dispatch_status !== "started") {
    throw runStoreError("run_transition_invalid", "Run cannot heartbeat in this state");
  }
  assertOwner(record, transition.owner_id);
  if (record.heartbeat_at !== undefined &&
    Date.parse(record.heartbeat_at) === Date.parse(occurredAt)) {
    throw runStoreError("run_transition_invalid", "Heartbeat must advance run time");
  }
  return {
    ...record,
    record_revision: nextRevision(record),
    heartbeat_at: occurredAt,
    updated_at: occurredAt
  };
}

function progress(
  record: RunRecord,
  transition: Extract<RunTransition, { kind: "progress" }>,
  occurredAt: string
): RunRecord {
  if (record.dispatch_status !== "started") {
    throw runStoreError("run_transition_invalid", "Only started runs can report progress");
  }
  assertOwner(record, transition.owner_id);
  assertUniqueNodes(transition.active_node_ids);
  const nextArtifactCount = monotonicCount(
    record.artifact_count,
    transition.artifact_count,
    "Artifact count"
  );
  const nextInterruptCount = monotonicCount(
    record.interrupt_count,
    transition.interrupt_count,
    "Interrupt count"
  );
  if (record.heartbeat_at !== undefined &&
    Date.parse(record.heartbeat_at) === Date.parse(occurredAt) &&
    nextArtifactCount === record.artifact_count &&
    nextInterruptCount === record.interrupt_count &&
    transition.active_node_ids.length === record.active_node_ids.length &&
    transition.active_node_ids.every((nodeId, index) => nodeId === record.active_node_ids[index])) {
    throw runStoreError("run_transition_invalid", "Progress transition has no changes");
  }
  return {
    ...record,
    record_revision: nextRevision(record),
    active_node_ids: transition.active_node_ids,
    artifact_count: nextArtifactCount,
    interrupt_count: nextInterruptCount,
    heartbeat_at: occurredAt,
    updated_at: occurredAt
  };
}

function runtimeStatus(
  record: RunRecord,
  transition: Extract<RunTransition, { kind: "runtime_status" }>,
  occurredAt: string
): RunRecord {
  if (record.dispatch_status !== "started" || record.run_status === undefined) {
    throw runStoreError("run_transition_invalid", "Runtime status requires a started run");
  }
  assertOwner(record, transition.owner_id);
  assertUniqueNodes(transition.active_node_ids);
  if (!ALLOWED_RUNTIME_TRANSITIONS[record.run_status].includes(transition.status)) {
    throw runStoreError("run_transition_invalid", "Runtime status transition is not allowed", {
      run_id: record.run_id,
      revision: record.record_revision
    });
  }

  const terminal = RunTerminalStatusSchema.safeParse(transition.status).success;
  if (terminal && transition.active_node_ids.length > 0) {
    throw runStoreError("run_transition_invalid", "Terminal transition cannot keep active nodes");
  }
  if ((transition.status === "failed" || transition.status === "timed_out") &&
    transition.failure === undefined) {
    throw runStoreError("run_transition_invalid", "Failure details are required");
  }
  if (transition.status === "succeeded" &&
    (transition.failure !== undefined || transition.failed_node_id !== undefined)) {
    throw runStoreError("run_transition_invalid", "Successful runs cannot carry failure details");
  }
  if (!terminal &&
    (transition.failure !== undefined || transition.failed_node_id !== undefined)) {
    throw runStoreError("run_transition_invalid", "Active states cannot carry terminal failure");
  }

  return {
    ...withoutTerminalDetails(record),
    record_revision: nextRevision(record),
    run_status: transition.status,
    active_node_ids: transition.active_node_ids,
    ...(transition.failed_node_id === undefined ? {} : { failed_node_id: transition.failed_node_id }),
    ...(transition.failure === undefined ? {} : { failure: transition.failure }),
    artifact_count: monotonicCount(
      record.artifact_count,
      transition.artifact_count,
      "Artifact count"
    ),
    interrupt_count: monotonicCount(
      record.interrupt_count,
      transition.interrupt_count,
      "Interrupt count"
    ),
    heartbeat_at: occurredAt,
    ...(terminal ? { finished_at: occurredAt } : {}),
    updated_at: occurredAt
  };
}

export function applyRunTransition(
  current: RunRecord,
  transitionInput: RunTransition,
  occurredAt: string
): RunRecord {
  const record = parseRunContract(RunRecordSchema, current, "ledger command");
  const transition = parseRunContract(
    RunTransitionSchema,
    transitionInput,
    "ledger command"
  );
  assertMutable(record);
  assertMonotonicTime(record, occurredAt);

  const next = (() => {
    switch (transition.kind) {
      case "dispatch_preparing":
        return preparing(record, transition, occurredAt);
      case "dispatch_started":
        return started(record, transition, occurredAt);
      case "dispatch_rejected":
        return rejected(record, transition, occurredAt);
      case "heartbeat":
        return heartbeat(record, transition, occurredAt);
      case "progress":
        return progress(record, transition, occurredAt);
      case "runtime_status":
        return runtimeStatus(record, transition, occurredAt);
    }
  })();

  const parsed = RunRecordSchema.safeParse(next);
  if (!parsed.success) {
    throw runStoreError(
      "run_transition_invalid",
      "Run transition produced an invalid record"
    );
  }
  return parsed.data;
}

export function runTransitionEventType(transition: RunTransition): string {
  switch (transition.kind) {
    case "dispatch_preparing":
      return "run.dispatch.preparing";
    case "dispatch_started":
      return "run.dispatch.started";
    case "dispatch_rejected":
      return "run.dispatch.rejected";
    case "heartbeat":
      return "run.heartbeat";
    case "progress":
      return "run.progress";
    case "runtime_status":
      return `run.status.${transition.status}`;
  }
}

export function runDisplayStatus(record: RunRecord): RunDisplayStatus {
  return record.run_status ?? record.dispatch_status;
}

export function wallDurationMs(record: RunRecord, asOf: string): number {
  const start = Date.parse(record.started_at ?? record.created_at);
  const end = Date.parse(record.finished_at ?? asOf);
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, end - start));
}
