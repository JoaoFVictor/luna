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
    "outcome_unknown",
    "timed_out",
    "cancelled"
  ],
  waiting_for_input: [
    "resuming",
    "failed",
    "outcome_unknown",
    "timed_out",
    "cancelled"
  ],
  waiting_for_retry: [
    "resuming",
    "failed",
    "outcome_unknown",
    "timed_out",
    "cancelled"
  ],
  resuming: [
    "running",
    "waiting_for_input",
    "waiting_for_retry",
    "failed",
    "outcome_unknown",
    "timed_out",
    "cancelled"
  ],
  succeeded: [],
  failed: [],
  outcome_unknown: [],
  timed_out: [],
  cancelled: []
};

export function initialRunRecord(input: PreallocateRunInput): RunRecord {
  const command = parseRunContract(PreallocateRunInputSchema, input, "ledger command");
  return RunRecordSchema.parse({
    schema_version: 1,
    record_revision: 1,
    run_id: command.run_id,
    ...(command.accepted_plan_id === undefined
      ? {}
      : { accepted_plan_id: command.accepted_plan_id }),
    ...(command.input_provenance === undefined
      ? {}
      : { input_provenance: command.input_provenance }),
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
    lifecycle_projection: "exact",
    completeness: "complete"
  });
}

function isImmutable(record: RunRecord): boolean {
  return record.dispatch_status === "rejected" ||
    record.dispatch_status === "historical_unknown" ||
    (record.run_status !== undefined &&
      RunTerminalStatusSchema.safeParse(record.run_status).success);
}

function assertMutable(record: RunRecord): void {
  if (isImmutable(record)) {
    throw runStoreError(
      "run_terminal_immutable",
      "Immutable run records cannot be changed",
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

function knownRunCount(
  record: RunRecord,
  field: "artifact_count" | "interrupt_count"
): number {
  const value = record[field];
  if (value === undefined) {
    throw runStoreError(
      "run_transition_invalid",
      "Mutable run is missing canonical lifecycle counts",
      { run_id: record.run_id, revision: record.record_revision }
    );
  }
  return value;
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

function recoveryClaimed(
  record: RunRecord,
  transition: Extract<RunTransition, { kind: "dispatch_recovery_claim" }>,
  occurredAt: string
): RunRecord {
  if (
    record.dispatch_status !== "started" ||
    record.run_status !== "running"
  ) {
    throw runStoreError(
      "run_transition_invalid",
      "Only unfinished running dispatches can be claimed for recovery"
    );
  }
  if (record.owner_id !== transition.previous_owner_id) {
    throw runStoreError(
      "run_owner_conflict",
      "Recovery claim does not match the previous run owner",
      { run_id: record.run_id, revision: record.record_revision }
    );
  }
  return {
    ...record,
    record_revision: nextRevision(record),
    owner_id: transition.owner_id,
    heartbeat_at: occurredAt,
    active_node_ids: [],
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
  const artifactCount = knownRunCount(record, "artifact_count");
  const interruptCount = knownRunCount(record, "interrupt_count");
  const nextArtifactCount = monotonicCount(
    artifactCount,
    transition.artifact_count,
    "Artifact count"
  );
  const nextInterruptCount = monotonicCount(
    interruptCount,
    transition.interrupt_count,
    "Interrupt count"
  );
  if (record.heartbeat_at !== undefined &&
    Date.parse(record.heartbeat_at) === Date.parse(occurredAt) &&
    nextArtifactCount === artifactCount &&
    nextInterruptCount === interruptCount &&
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

function projectionTimestamp(record: RunRecord, occurredAt: string): string {
  return new Date(
    Math.max(Date.parse(record.updated_at), Date.parse(occurredAt))
  ).toISOString();
}

function nodeLifecycle(
  record: RunRecord,
  transition: Extract<RunTransition, { kind: "node_lifecycle" }>,
  occurredAt: string
): RunRecord {
  if (record.dispatch_status !== "started") {
    throw runStoreError(
      "run_transition_invalid",
      "Only started runs can report node lifecycle"
    );
  }
  assertOwner(record, transition.owner_id);
  const artifactCount = knownRunCount(record, "artifact_count");
  const interruptCount = knownRunCount(record, "interrupt_count");
  const activeNodeIds = new Set(record.active_node_ids);
  if (transition.event.type === "node.started") {
    activeNodeIds.add(transition.event.node_id);
  } else {
    activeNodeIds.delete(transition.event.node_id);
  }
  const projectedAt = projectionTimestamp(record, occurredAt);
  return {
    ...record,
    record_revision: nextRevision(record),
    active_node_ids: [...activeNodeIds].sort((left, right) =>
      left.localeCompare(right)
    ),
    artifact_count: Math.max(
      artifactCount,
      transition.event.artifact_count
    ),
    interrupt_count: Math.max(
      interruptCount,
      transition.event.interrupt_count
    ),
    heartbeat_at: projectedAt,
    updated_at: projectedAt
  };
}

function lifecycleProjectionDegraded(
  record: RunRecord,
  transition: Extract<
    RunTransition,
    { kind: "lifecycle_projection_degraded" }
  >,
  occurredAt: string
): RunRecord {
  if (record.dispatch_status !== "started") {
    throw runStoreError(
      "run_transition_invalid",
      "Only started runs can degrade lifecycle projection"
    );
  }
  assertOwner(record, transition.owner_id);
  const projectedAt = projectionTimestamp(record, occurredAt);
  return {
    ...record,
    record_revision: nextRevision(record),
    lifecycle_projection: "degraded",
    heartbeat_at: projectedAt,
    updated_at: projectedAt
  };
}

function assertOutcomeProof(
  record: RunRecord,
  transition: Extract<RunTransition, { kind: "runtime_status" }>
): void {
  const proof = transition.outcome_proof;
  const terminal = RunTerminalStatusSchema.safeParse(transition.status).success;
  if (!terminal && proof !== undefined) {
    throw runStoreError(
      "run_transition_invalid",
      "Only terminal transitions can carry an outcome proof"
    );
  }
  if (transition.completeness === "complete" && proof === undefined) {
    throw runStoreError(
      "run_transition_invalid",
      "Complete terminal transitions require a durable outcome proof"
    );
  }
  if (proof === undefined) {
    return;
  }
  if (
    proof.identity.graph_snapshot_handle !== record.graph_snapshot_handle ||
    proof.identity.run_id !== record.run_id ||
    proof.identity.workflow_id !== record.workflow_id ||
    proof.identity.workflow_revision !== record.workflow_revision ||
    proof.identity.definition_bundle_hash !== record.definition_bundle_hash ||
    proof.identity.execution_snapshot_hash !== record.execution_snapshot_hash ||
    proof.record_revision !== nextRevision(record) ||
    proof.run_status !== transition.status
  ) {
    throw runStoreError(
      "run_transition_invalid",
      "Terminal outcome proof does not match the exact run identity"
    );
  }
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
  const artifactCount = knownRunCount(record, "artifact_count");
  const interruptCount = knownRunCount(record, "interrupt_count");
  assertOutcomeProof(record, transition);
  if (terminal && transition.active_node_ids.length > 0) {
    throw runStoreError("run_transition_invalid", "Terminal transition cannot keep active nodes");
  }
  if ((transition.status === "failed" ||
    transition.status === "outcome_unknown" ||
    transition.status === "timed_out") &&
    transition.failure === undefined) {
    throw runStoreError(
      "run_transition_invalid",
      "Failure or uncertain-outcome details are required"
    );
  }
  if (transition.status === "succeeded" &&
    (transition.failure !== undefined || transition.failed_node_id !== undefined)) {
    throw runStoreError("run_transition_invalid", "Successful runs cannot carry failure details");
  }
  if (!terminal &&
    (transition.failure !== undefined || transition.failed_node_id !== undefined)) {
    throw runStoreError("run_transition_invalid", "Active states cannot carry terminal failure");
  }
  if (!terminal && transition.completeness !== undefined) {
    throw runStoreError(
      "run_transition_invalid",
      "Only terminal transitions can change run completeness"
    );
  }
  if (
    terminal &&
    transition.completeness === "complete" &&
    record.lifecycle_projection === "degraded"
  ) {
    throw runStoreError(
      "run_transition_invalid",
      "Degraded lifecycle projection cannot produce a complete terminal run"
    );
  }

  return {
    ...withoutTerminalDetails(record),
    record_revision: nextRevision(record),
    run_status: transition.status,
    active_node_ids: transition.active_node_ids,
    ...(transition.failed_node_id === undefined ? {} : { failed_node_id: transition.failed_node_id }),
    ...(transition.failure === undefined ? {} : { failure: transition.failure }),
    artifact_count: monotonicCount(
      artifactCount,
      transition.artifact_count,
      "Artifact count"
    ),
    interrupt_count: monotonicCount(
      interruptCount,
      transition.interrupt_count,
      "Interrupt count"
    ),
    completeness: terminal
      ? transition.completeness ?? "partial"
      : record.completeness,
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
  if (
    transition.kind !== "node_lifecycle" &&
    transition.kind !== "lifecycle_projection_degraded"
  ) {
    assertMonotonicTime(record, occurredAt);
  }

  const next = (() => {
    switch (transition.kind) {
      case "dispatch_preparing":
        return preparing(record, transition, occurredAt);
      case "dispatch_started":
        return started(record, transition, occurredAt);
      case "dispatch_recovery_claim":
        return recoveryClaimed(record, transition, occurredAt);
      case "dispatch_rejected":
        return rejected(record, transition, occurredAt);
      case "heartbeat":
        return heartbeat(record, transition, occurredAt);
      case "progress":
        return progress(record, transition, occurredAt);
      case "node_lifecycle":
        return nodeLifecycle(record, transition, occurredAt);
      case "lifecycle_projection_degraded":
        return lifecycleProjectionDegraded(record, transition, occurredAt);
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
    case "dispatch_recovery_claim":
      return "run.dispatch.recovery_claimed";
    case "dispatch_rejected":
      return "run.dispatch.rejected";
    case "heartbeat":
      return "run.heartbeat";
    case "progress":
      return "run.progress";
    case "node_lifecycle":
      return `run.${transition.event.type}`;
    case "lifecycle_projection_degraded":
      return "run.lifecycle.projection_degraded";
    case "runtime_status":
      return `run.status.${transition.status}`;
  }
}

export function runDisplayStatus(record: RunRecord): RunDisplayStatus {
  return record.run_status ?? record.dispatch_status;
}

export function wallDurationMs(
  record: RunRecord,
  asOf: string
): number | undefined {
  if (record.dispatch_status === "historical_unknown") {
    return undefined;
  }
  const start = Date.parse(record.started_at ?? record.created_at);
  const end = Date.parse(record.finished_at ?? asOf);
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, end - start));
}
