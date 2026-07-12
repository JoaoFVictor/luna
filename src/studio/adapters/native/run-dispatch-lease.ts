import { randomBytes } from "node:crypto";
import type { LunaRuntimeState } from "../../../core/runtime/state.js";
import type { WorkflowNodeLifecycleEvent } from "../../../core/workflow/events.js";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import { applyRunTransition } from "../../application/runs/lifecycle.js";
import {
  runGraphOutcomeProof,
  type StoredRunGraphOutcome
} from "../../application/runs/graph-snapshot.js";
import { studioRunLaunchError } from "../../application/runs/launch-errors.js";
import { failureDiagnosticsFrom } from "../../application/runs/failure-diagnostics.js";
import type {
  AppendRunTransitionInput,
  RunLedgerPort,
  RunTransition
} from "../../application/runs/ports.js";
import {
  RunOpaqueIdSchema,
  type RunRecord
} from "../../contracts/runs.js";

export type NativeStudioRunTerminal =
  | {
      readonly status: "succeeded";
      readonly state: LunaRuntimeState;
    }
  | {
      readonly status: "failed";
      readonly state?: LunaRuntimeState;
      readonly cause: unknown;
    };

export type NativeStudioRunTerminalPreparation = {
  readonly command: AppendRunTransitionInput;
  readonly projectedRecord: RunRecord;
  readonly outcome?: StoredRunGraphOutcome;
};

export type NativeStudioRunRecoveryClaim = {
  readonly run_id: string;
  readonly previous_owner_id: string;
  readonly expected_revision: number;
  readonly expected_heartbeat_at: string;
  readonly stale_before: string;
  readonly recovery_intent_hash: string;
};

type NativeStudioRunLeasePhase =
  | "active"
  | "terminalizing"
  | "released";

type NativeStudioMutableTransitionPrefix =
  | "transition"
  | "heartbeat"
  | "terminal-lease";

const NATIVE_STUDIO_RUN_LEASE_TOKEN_BYTES = 16;
const NATIVE_STUDIO_RUN_LEASE_TOKEN_PATTERN = /^[a-f0-9]{32}$/;

function createNativeStudioRunLeaseToken(): string {
  // This nonce only separates mutable ledger commands. It is never used as
  // authorization material, so persisting it inside an opaque id grants no
  // capability and exposes no credential.
  let token: string;
  try {
    token = randomBytes(NATIVE_STUDIO_RUN_LEASE_TOKEN_BYTES).toString("hex");
  } catch (cause) {
    throw studioRunLaunchError(
      "studio_run_dispatch_failed",
      "Native run lease identity could not be created",
      {},
      { cause }
    );
  }
  if (!NATIVE_STUDIO_RUN_LEASE_TOKEN_PATTERN.test(token)) {
    throw studioRunLaunchError(
      "studio_run_dispatch_failed",
      "Native run lease identity is invalid"
    );
  }
  return token;
}

type NodeLifecycleIdentity = Pick<
  WorkflowNodeLifecycleEvent,
  "type" | "node_id" | "attempt" | "occurred_at"
>;

export function nativeStudioTransitionTimestamp(
  now: () => number,
  record: RunRecord
): string {
  const previous = Date.parse(record.updated_at);
  const current = now();
  const value = Math.max(current, previous + 1);
  if (
    !Number.isFinite(previous) ||
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw studioRunLaunchError(
      "studio_run_dispatch_failed",
      "Native run dispatcher clock is invalid"
    );
  }
  try {
    return new Date(value).toISOString();
  } catch (cause) {
    throw studioRunLaunchError(
      "studio_run_dispatch_failed",
      "Native run dispatcher clock is outside the supported date range",
      {},
      { cause }
    );
  }
}

function failureCode(cause: unknown): string {
  const candidate = (cause as { readonly code?: unknown })?.code;
  return typeof candidate === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(candidate)
    ? candidate
    : "studio_native_run_failed";
}

export class NativeStudioRunLease {
  readonly #ledger: RunLedgerPort;
  readonly #runId: string;
  readonly #ownerId: string;
  readonly #leaseToken: string;
  readonly #now: () => number;
  readonly #heartbeatIntervalMs: number;
  readonly #onHeartbeatError: (cause: unknown) => void;
  #tail: Promise<void> = Promise.resolve();
  #counter = 0;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #projectionFailure: NodeLifecycleIdentity | undefined;
  #heartbeatFailure: unknown;
  #phase: NativeStudioRunLeasePhase = "active";

  constructor(options: {
    readonly ledger: RunLedgerPort;
    readonly runId: string;
    readonly ownerId: string;
    readonly now: () => number;
    readonly heartbeatIntervalMs: number;
    readonly onHeartbeatError?: (cause: unknown) => void;
  }) {
    this.#ledger = options.ledger;
    this.#runId = options.runId;
    this.#ownerId = options.ownerId;
    this.#leaseToken = createNativeStudioRunLeaseToken();
    this.#now = options.now;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.#onHeartbeatError = options.onHeartbeatError ?? (() => undefined);
  }

  async prepare(): Promise<RunRecord> {
    return await this.transition({
      kind: "dispatch_preparing",
      owner_id: this.#ownerId
    });
  }

  async start(): Promise<RunRecord> {
    return await this.transition({
      kind: "dispatch_started",
      owner_id: this.#ownerId,
      active_node_ids: []
    });
  }

  async claimRecovery(
    claim: NativeStudioRunRecoveryClaim
  ): Promise<RunRecord> {
    return await this.enqueue(async () => {
      if (this.#phase !== "active") {
        throw studioRunLaunchError(
          "studio_run_dispatch_failed",
          "Native run lease cannot claim recovery after release"
        );
      }
      const record = await this.currentRecord();
      const staleBeforeMs = Date.parse(claim.stale_before);
      if (
        claim.run_id !== this.#runId ||
        !Number.isFinite(staleBeforeMs) ||
        record.dispatch_status !== "started" ||
        record.run_status !== "running" ||
        record.record_revision !== claim.expected_revision ||
        record.owner_id !== claim.previous_owner_id ||
        record.heartbeat_at !== claim.expected_heartbeat_at ||
        Date.parse(record.heartbeat_at) >= staleBeforeMs
      ) {
        throw studioRunLaunchError(
          "studio_run_dispatch_failed",
          "Native run recovery claim is no longer stale and exact"
        );
      }
      const digest = sha256Digest({
        schema_version: 1,
        run_id: this.#runId,
        previous_owner_id: claim.previous_owner_id,
        owner_id: this.#ownerId,
        record_revision: claim.expected_revision,
        heartbeat_at: claim.expected_heartbeat_at,
        stale_before: claim.stale_before,
        recovery_intent_hash: claim.recovery_intent_hash
      });
      return await this.append(record, {
        transition_id: `recovery-claim-${digest}`,
        event_id: `event-recovery-claim-${digest}`,
        transition: {
          kind: "dispatch_recovery_claim",
          previous_owner_id: claim.previous_owner_id,
          owner_id: this.#ownerId
        }
      });
    });
  }

  async releaseForRecovery(): Promise<void> {
    if (this.#phase === "released") {
      return;
    }
    this.beginRelease("release for recovery");
    this.stopHeartbeat();
    try {
      // A heartbeat may already be executing on the serialized tail. Waiting
      // here guarantees that no lease refresh can land after the executor has
      // advertised the run as recoverable.
      await this.#tail;
    } finally {
      this.#phase = "released";
      this.stopHeartbeat();
    }
  }

  hasHeartbeatFailure(): boolean {
    return this.#heartbeatFailure !== undefined;
  }

  heartbeatFailure(): unknown {
    return this.#heartbeatFailure;
  }

  async markOutcomeUnknown(input: {
    readonly code: string;
    readonly message: string;
  }): Promise<RunRecord> {
    this.beginRelease("mark an uncertain outcome");
    try {
      return await this.transition({
        kind: "runtime_status",
        owner_id: this.#ownerId,
        status: "outcome_unknown",
        active_node_ids: [],
        completeness: "partial",
        failure: {
          ...input,
          diagnostics: failureDiagnosticsFrom({
            cause: input,
            code: input.code,
            certainty: "unknown"
          })
        }
      });
    } finally {
      this.#phase = "released";
      this.stopHeartbeat();
    }
  }

  async observeNode(event: WorkflowNodeLifecycleEvent): Promise<RunRecord> {
    const occurredAt = normalizedLifecycleTimestamp(event.occurred_at);
    const digest = sha256Digest({
      schema_version: 1,
      run_id: this.#runId,
      type: event.type,
      node_id: event.node_id,
      attempt: event.attempt
    });
    return await this.enqueue(async () => {
      const record = await this.currentRecord();
      try {
        return await this.append(record, {
          transition_id: `runtime-${digest}`,
          event_id: `event-runtime-${digest}`,
          occurred_at: lifecycleTransitionTimestamp(record, occurredAt),
          transition: {
            kind: "node_lifecycle",
            owner_id: this.#ownerId,
            event: {
              type: event.type,
              node_id: event.node_id,
              attempt: event.attempt,
              observed_at: occurredAt,
              artifact_count: event.artifact_count,
              interrupt_count: event.interrupt_count
            }
          }
        });
      } catch (cause) {
        this.#projectionFailure ??= {
          type: event.type,
          node_id: event.node_id,
          attempt: event.attempt,
          occurred_at: occurredAt
        };
        const current = await this.currentRecord().catch(() => undefined);
        if (current !== undefined) {
          await this.persistProjectionFailure(current).catch(() => undefined);
        }
        throw cause;
      }
    });
  }

  startHeartbeat(): void {
    if (this.#heartbeat !== undefined || this.#phase !== "active") {
      return;
    }
    this.#heartbeat = setInterval(() => {
      void this.heartbeat().catch((cause) => {
        if (this.#heartbeatFailure !== undefined) {
          return;
        }
        this.#heartbeatFailure = cause;
        this.stopHeartbeat();
        try {
          this.#onHeartbeatError(cause);
        } catch {
          // The lease is already poisoned; reporting must not hide that state.
        }
      });
    }, this.#heartbeatIntervalMs);
    this.#heartbeat.unref();
  }

  async reject(cause: unknown): Promise<void> {
    this.beginRelease("reject");
    try {
      const code = failureCode(cause);
      await this.transition({
        kind: "dispatch_rejected",
        owner_id: this.#ownerId,
        failure: {
          code,
          message: "Native workflow dispatch failed before runtime start",
          diagnostics: failureDiagnosticsFrom({ cause, code })
        }
      });
    } finally {
      this.#phase = "released";
      this.stopHeartbeat();
    }
  }

  async waitForInput(state: LunaRuntimeState): Promise<RunRecord> {
    this.beginRelease("wait for input");
    const waitingNodeIds = Object.entries(state.node_statuses)
      .filter(([, status]) => status.status === "waiting_for_input")
      .map(([nodeId]) => nodeId)
      .sort((left, right) => left.localeCompare(right));
    try {
      return await this.transition({
        kind: "runtime_status",
        owner_id: this.#ownerId,
        status: "waiting_for_input",
        active_node_ids: waitingNodeIds,
        artifact_count: state.artifact_refs.length,
        interrupt_count: state.interrupt_refs.length
      });
    } finally {
      this.#phase = "released";
      this.stopHeartbeat();
    }
  }

  async commitTerminal(
    terminal: NativeStudioRunTerminal,
    options: {
      readonly completeness: "complete" | "partial";
      readonly createOutcome?: (
        recordRevision: number
      ) => StoredRunGraphOutcome;
    },
    commit: (
      preparation: NativeStudioRunTerminalPreparation
    ) => Promise<void>
  ): Promise<void> {
    return await this.enqueue(async () => {
      if (this.#phase !== "active") {
        throw studioRunLaunchError(
          "studio_run_dispatch_failed",
          "Native run lease cannot terminalize more than once"
        );
      }
      this.#phase = "terminalizing";
      try {
        // Refresh the durable lease inside the same serialized operation that
        // builds and persists the terminal outbox entry. Timer callbacks that
        // are already queued observe the terminalizing phase and cannot move
        // the revision behind the intent.
        const current = await this.persistProjectionFailure(
          await this.currentRecord()
        );
        const record = await this.append(current, {
          ...this.nextTransitionIdentity("terminal-lease"),
          transition: {
            kind: "heartbeat",
            owner_id: this.#ownerId
          }
        });
        await commit(this.terminalPreparation(record, terminal, options));
      } finally {
        this.#phase = "released";
        this.stopHeartbeat();
      }
    });
  }

  private terminalPreparation(
    record: RunRecord,
    terminal: NativeStudioRunTerminal,
    options: {
      readonly completeness: "complete" | "partial";
      readonly createOutcome?: (
        recordRevision: number
      ) => StoredRunGraphOutcome;
    }
  ): NativeStudioRunTerminalPreparation {
    const state = terminal.state;
    const terminalRevision = record.record_revision + 1;
    if (!Number.isSafeInteger(terminalRevision)) {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        "Native run terminal revision is exhausted"
      );
    }
    const outcome = options.createOutcome?.(terminalRevision);
    const failure = terminal.status === "failed"
      ? (() => {
          const code = failureCode(terminal.cause);
          return {
            code,
            message: "Native workflow execution failed",
            diagnostics: failureDiagnosticsFrom({
              cause: terminal.cause,
              code
            })
          };
        })()
      : undefined;
    const transition: RunTransition = {
      kind: "runtime_status",
      owner_id: this.#ownerId,
      status: terminal.status,
      active_node_ids: [],
      ...(failure === undefined
        ? {}
        : {
            ...(state?.primary_failure === undefined
              ? {}
              : { failed_node_id: state.primary_failure.node_id }),
            failure
          }),
      ...(state === undefined
        ? { completeness: "partial" as const }
        : {
            completeness: options.completeness,
            artifact_count: state.artifact_refs.length,
            interrupt_count: state.interrupt_refs.length
          }),
      ...(outcome === undefined
        ? {}
        : { outcome_proof: runGraphOutcomeProof(outcome) })
    };
    const occurredAt = nativeStudioTransitionTimestamp(this.#now, record);
    const projectedRecord = applyRunTransition(record, transition, occurredAt);
    const suffix = sha256Digest({
      schema_version: 1,
      run_id: this.#runId,
      owner_id: this.#ownerId,
      record_revision: projectedRecord.record_revision,
      transition
    });
    return {
      command: {
        run_id: this.#runId,
        transition_id: `terminal-${suffix}`,
        event_id: `event-terminal-${suffix}`,
        expected_revision: record.record_revision,
        occurred_at: occurredAt,
        transition
      },
      projectedRecord,
      ...(outcome === undefined ? {} : { outcome })
    };
  }

  private stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
  }

  private beginRelease(operation: string): void {
    if (this.#phase !== "active") {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        `Native run lease cannot ${operation} after release`
      );
    }
    this.#phase = "terminalizing";
  }

  private async transition(transition: RunTransition): Promise<RunRecord> {
    return await this.enqueue(async () => {
      const record = await this.persistProjectionFailure(
        await this.currentRecord()
      );
      return await this.append(record, {
        ...this.nextTransitionIdentity("transition"),
        transition
      });
    });
  }

  private async heartbeat(): Promise<void> {
    await this.enqueue(async () => {
      if (this.#phase !== "active") {
        return;
      }
      const record = await this.persistProjectionFailure(
        await this.currentRecord()
      );
      await this.append(record, {
        ...this.nextTransitionIdentity("heartbeat"),
        transition: {
          kind: "heartbeat",
          owner_id: this.#ownerId
        }
      });
    });
  }

  private nextTransitionIdentity(
    prefix: NativeStudioMutableTransitionPrefix
  ): {
    readonly transition_id: string;
    readonly event_id: string;
  } {
    this.#counter += 1;
    if (!Number.isSafeInteger(this.#counter)) {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        "Native run lease transition identity is exhausted"
      );
    }
    const suffix = `${this.#leaseToken}-${this.#counter}`;
    const identity = {
      transition_id: `${prefix}-${suffix}`,
      event_id: `event-${prefix}-${suffix}`
    };
    if (
      !RunOpaqueIdSchema.safeParse(identity.transition_id).success ||
      !RunOpaqueIdSchema.safeParse(identity.event_id).success
    ) {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        "Native run lease transition identity is invalid"
      );
    }
    return identity;
  }

  private async currentRecord(): Promise<RunRecord> {
    const record = await this.#ledger.get(this.#runId);
    if (record === undefined) {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        "Preallocated native run disappeared from the ledger"
      );
    }
    return record;
  }

  private async append(
    record: RunRecord,
    input: {
      readonly transition_id: string;
      readonly event_id: string;
      readonly occurred_at?: string;
      readonly transition: RunTransition;
    }
  ): Promise<RunRecord> {
    return (
      await this.#ledger.appendTransition({
        run_id: this.#runId,
        transition_id: input.transition_id,
        event_id: input.event_id,
        expected_revision: record.record_revision,
        occurred_at: input.occurred_at ??
          nativeStudioTransitionTimestamp(this.#now, record),
        transition: input.transition
      })
    ).record;
  }

  private async persistProjectionFailure(record: RunRecord): Promise<RunRecord> {
    const failure = this.#projectionFailure;
    if (
      failure === undefined ||
      record.dispatch_status !== "started" ||
      record.lifecycle_projection === "degraded"
    ) {
      return record;
    }
    const digest = sha256Digest({
      schema_version: 1,
      run_id: this.#runId,
      type: failure.type,
      node_id: failure.node_id,
      attempt: failure.attempt
    });
    return await this.append(record, {
      transition_id: `projection-degraded-${digest}`,
      event_id: `event-projection-degraded-${digest}`,
      occurred_at: lifecycleTransitionTimestamp(record, failure.occurred_at),
      transition: {
        kind: "lifecycle_projection_degraded",
        owner_id: this.#ownerId,
        failed_event: {
          type: failure.type,
          node_id: failure.node_id,
          attempt: failure.attempt,
          observed_at: failure.occurred_at
        }
      }
    });
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined
    );
    return await result;
  }
}

function normalizedLifecycleTimestamp(observedAt: string): string {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) {
    throw studioRunLaunchError(
      "studio_run_dispatch_failed",
      "Runtime node lifecycle timestamp is invalid"
    );
  }
  return new Date(observed).toISOString();
}

function lifecycleTransitionTimestamp(
  record: RunRecord,
  observedAt: string
): string {
  return new Date(
    Math.max(Date.parse(record.updated_at), Date.parse(observedAt))
  ).toISOString();
}
