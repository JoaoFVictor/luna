import { validateCheckpointState } from "../../../core/runtime/state.js";
import type { LunaRuntimeState } from "../../../core/runtime/state.js";
import {
  assertCheckpointJsonValue,
  isCheckpointPlainObject
} from "../../../core/runtime/json.js";
import type { WorkflowRunResult } from "../../../core/workflow/execution-contracts.js";
import type { NativeWorkflowRunInput } from "../../../runtime/composition/target-executor.js";
import { isRuntimeDurabilityRecoveryRequired } from "../../../core/runtime/errors.js";
import {
  RunGraphSnapshotIdentitySchema,
  projectStoredRunGraphOutcome,
  projectStoredRunGraphSnapshot,
  type RunGraphSnapshotIdentity,
  type RunGraphSnapshotStorePort,
  type StoredRunGraphSnapshot
} from "../../application/runs/graph-snapshot.js";
import { studioRunLaunchError } from "../../application/runs/launch-errors.js";
import type { RunRecord } from "../../contracts/runs.js";
import { NativeStudioRunDispatchQueue } from "../filesystem/run-dispatch-queue.js";
import type { NativeStudioQueuedRun } from "../filesystem/run-dispatch-contracts.js";
import type { NativeStudioRunRecoveryJournalPort } from "../filesystem/run-recovery-journal.js";
import { verifyMaterializedNativeStudioRunSnapshot } from "./run-definition-snapshot.js";
import { NativeStudioRunLease } from "./run-dispatch-lease.js";
import { NativeStudioRunFinalizer } from "./run-finalizer.js";
import { createNativeStudioRunTerminalIntent } from "./run-terminal-intent.js";
import {
  verifyPinnedNativeStudioRepository
} from "./run-dispatch-material.js";
import {
  createNativeStudioRunRecoveryIntent,
  type NativeStudioRunRecoveryReason
} from "./run-recovery-intent.js";
import {
  nativeStudioCheckpointReplayIsSafe,
  nativeStudioFailedTerminalIsSafe
} from "./run-recovery-safety.js";
import { nativePrecompletedSteps } from "./run-execution-profile.js";

type NativeStudioRunWorkflow = (
  input: NativeWorkflowRunInput
) => Promise<unknown>;

function graphSnapshotIdentity(record: RunRecord): RunGraphSnapshotIdentity {
  return RunGraphSnapshotIdentitySchema.parse({
    graph_snapshot_handle: record.graph_snapshot_handle,
    run_id: record.run_id,
    workflow_id: record.workflow_id,
    workflow_revision: record.workflow_revision,
    definition_bundle_hash: record.definition_bundle_hash,
    execution_snapshot_hash: record.execution_snapshot_hash
  });
}

function workflowRunResult(value: unknown): WorkflowRunResult {
  if (!isCheckpointPlainObject(value)) {
    throw studioRunLaunchError(
      "studio_run_dispatch_failed",
      "Native workflow runner returned an invalid result"
    );
  }
  const candidate = value;
  if (
    (candidate.status !== "succeeded" &&
      candidate.status !== "waiting_for_input") ||
    candidate.state === undefined
  ) {
    throw studioRunLaunchError(
      "studio_run_dispatch_failed",
      "Native workflow runner returned an invalid result"
    );
  }
  try {
    validateCheckpointState(candidate.state);
  } catch (cause) {
    throw studioRunLaunchError(
      "studio_run_dispatch_failed",
      "Native workflow runner returned an invalid runtime state",
      {},
      { cause }
    );
  }
  if (
    (candidate.status === "succeeded" &&
      candidate.state.run_status !== "succeeded") ||
    (candidate.status === "waiting_for_input" &&
      candidate.state.run_status !== "waiting_for_input")
  ) {
    throw studioRunLaunchError(
      "studio_run_dispatch_failed",
      "Native workflow result status does not match its runtime state"
    );
  }
  if (candidate.status === "succeeded") {
    try {
      assertCheckpointJsonValue(candidate.output, "$.output");
    } catch (cause) {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        "Native workflow runner returned an invalid succeeded output",
        {},
        { cause }
      );
    }
    return {
      status: "succeeded",
      output: candidate.output,
      state: candidate.state
    };
  }
  if (
    typeof candidate.interrupt_id !== "string" ||
    candidate.interrupt_id === "" ||
    typeof candidate.checkpoint_id !== "string" ||
    candidate.checkpoint_id === ""
  ) {
    throw studioRunLaunchError(
      "studio_run_dispatch_failed",
      "Native workflow runner returned incomplete durable interrupt identity"
    );
  }
  return {
    status: "waiting_for_input",
    interrupt_id: candidate.interrupt_id,
    checkpoint_id: candidate.checkpoint_id,
    state: candidate.state
  };
}

export class NativeStudioRunExecutor {
  readonly #projectRoot: string;
  readonly #configRoot: string;
  readonly #catalogFingerprint: string;
  readonly #queue: NativeStudioRunDispatchQueue;
  readonly #graphStore: RunGraphSnapshotStorePort;
  readonly #finalizer: NativeStudioRunFinalizer;
  readonly #recoveryJournal: NativeStudioRunRecoveryJournalPort;
  readonly #runWorkflow: NativeStudioRunWorkflow;

  constructor(options: {
    readonly projectRoot: string;
    readonly configRoot: string;
    readonly catalogFingerprint: string;
    readonly queue: NativeStudioRunDispatchQueue;
    readonly graphStore: RunGraphSnapshotStorePort;
    readonly finalizer: NativeStudioRunFinalizer;
    readonly recoveryJournal: NativeStudioRunRecoveryJournalPort;
    readonly runWorkflow: NativeStudioRunWorkflow;
  }) {
    this.#projectRoot = options.projectRoot;
    this.#configRoot = options.configRoot;
    this.#catalogFingerprint = options.catalogFingerprint;
    this.#queue = options.queue;
    this.#graphStore = options.graphStore;
    this.#finalizer = options.finalizer;
    this.#recoveryJournal = options.recoveryJournal;
    this.#runWorkflow = options.runWorkflow;
  }

  async execute(
    job: NativeStudioQueuedRun,
    preparingRecord: RunRecord,
    lease: NativeStudioRunLease,
    signal: AbortSignal
  ): Promise<void> {
    const snapshotIdentity = graphSnapshotIdentity(preparingRecord);
    const replaying = preparingRecord.dispatch_status === "started";
    let started = replaying;
    let compiledCaptured = false;
    let storedGraph: StoredRunGraphSnapshot | undefined;
    let failedState: LunaRuntimeState | undefined;
    let lifecycleProjectionComplete = true;
    let successBarrierAttempted = false;
    let successFinalized = false;
    let result: WorkflowRunResult;
    try {
      signal.throwIfAborted();
      if (job.catalog_fingerprint !== this.#catalogFingerprint) {
        throw studioRunLaunchError(
          "studio_run_dispatch_failed",
          "Pinned capability catalog is unavailable in this process"
        );
      }
      const definitionRoots = this.#queue.snapshotRootsFor(job.run_id);
      await verifyMaterializedNativeStudioRunSnapshot({
        roots: definitionRoots,
        manifest: job.snapshot
      });
      await verifyPinnedNativeStudioRepository(job, definitionRoots, signal);
      const rawResult = await this.#runWorkflow({
        projectRoot: this.#projectRoot,
        configRoot: this.#configRoot,
        definitionRoots,
        target: job.run.route_target,
        invocation: job.request.invocation,
        executionScope: job.request.execution_scope,
        precompleted_steps: nativePrecompletedSteps(
          job.request.execution_profile
        ),
        workflowConfig: job.request.config,
        run: job.run,
        signal,
        onSucceededState: async (state) => {
          if (successBarrierAttempted) {
            throw studioRunLaunchError(
              "studio_run_dispatch_failed",
              "Native workflow runner invoked the success durability barrier more than once"
            );
          }
          successBarrierAttempted = true;
          await this.finalize(
            lease,
            storedGraph,
            { status: "succeeded", state },
            lifecycleProjectionComplete,
            true
          );
          successFinalized = true;
        },
        onFailedState: (state) => {
          failedState ??= state;
        },
        onLifecycleEvent: async (event) => {
          await lease.observeNode(event);
        },
        onLifecycleProjectionError: () => {
          lifecycleProjectionComplete = false;
        },
        onCompiledWorkflow: async (compiled) => {
          signal.throwIfAborted();
          if (compiledCaptured) {
            throw studioRunLaunchError(
              "studio_run_dispatch_failed",
              "Native workflow runner invoked the compiled workflow barrier more than once"
            );
          }
          // Bind the compiled graph to the same immutable bytes checked before
          // loading. A mutation during definition loading must fail before the
          // lease starts and before any workflow node can execute.
          await verifyMaterializedNativeStudioRunSnapshot({
            roots: definitionRoots,
            manifest: job.snapshot
          });
          signal.throwIfAborted();
          compiledCaptured = true;
          storedGraph = projectStoredRunGraphSnapshot({
            identity: snapshotIdentity,
            compiled
          });
          await this.#graphStore.writeGraph(storedGraph);
          signal.throwIfAborted();
          if (!replaying) {
            await lease.start();
            started = true;
          }
        }
      });
      if (lease.hasHeartbeatFailure()) {
        throw lease.heartbeatFailure();
      }
      result = workflowRunResult(rawResult);
      if (!compiledCaptured || !started) {
        throw studioRunLaunchError(
          "studio_run_dispatch_failed",
          "Native workflow runner skipped the compiled workflow durability barrier"
        );
      }
    } catch (cause) {
      if (!started) {
        await lease.reject(cause);
        return;
      }
      if (successFinalized) {
        // The exact Studio terminal intent is already authoritative. Nothing
        // after that barrier may rewrite success as failure.
        return;
      }
      if (successBarrierAttempted) {
        // Leave the leased record for journal/orphan recovery. A failed
        // durability barrier must never trigger destructive cleanup or a
        // contradictory failed terminal intent.
        if (nativeStudioCheckpointReplayIsSafe(job)) {
          await this.persistRecoveryIntent(
            job,
            "success_barrier_recovery_required"
          );
        }
        throw cause;
      }
      if (lease.hasHeartbeatFailure()) {
        // Losing control-plane ownership while a node is in flight makes its
        // external acceptance unknowable. Never turn that into an
        // authoritative runtime failure or an automatic replay.
        await lease.markOutcomeUnknown({
          code: "studio_runtime_control_lost",
          message: "Runtime control was lost while an effect could still complete"
        });
        return;
      }
      if (isRuntimeDurabilityRecoveryRequired(cause)) {
        // The runtime may already have committed the exact deterministic
        // write. Stop refreshing the lease so a stale-owner CAS can replay the
        // same job and reconcile exact checkpoints instead of inventing a
        // contradictory failed terminal outcome.
        if (nativeStudioCheckpointReplayIsSafe(job)) {
          try {
            await this.persistRecoveryIntent(
              job,
              "runtime_durability_recovery_required"
            );
          } finally {
            await lease.releaseForRecovery();
          }
          throw cause;
        }
        await lease.markOutcomeUnknown({
          code: "studio_runtime_checkpoint_outcome_unknown",
          message: "Checkpoint acceptance is unknown for a run with write effects"
        });
        return;
      }
      if (!nativeStudioFailedTerminalIsSafe(job)) {
        // Until write operations expose an exact durable acceptance protocol,
        // any started failure in a write-capable plan remains conservative:
        // the effect may exist even when its output was never checkpointed.
        await lease.markOutcomeUnknown({
          code: "studio_runtime_write_outcome_unknown",
          message: "A write-capable run ended without proof of its external outcome"
        });
        return;
      }
      await this.finalize(
        lease,
        storedGraph,
        {
          status: "failed",
          ...(failedState === undefined ? {} : { state: failedState }),
          cause
        },
        lifecycleProjectionComplete
      );
      return;
    }
    if (result.status === "waiting_for_input") {
      if (successBarrierAttempted) {
        throw studioRunLaunchError(
          "studio_run_dispatch_failed",
          "Native workflow returned waiting after committing success"
        );
      }
      await lease.waitForInput(result.state);
      return;
    }
    if (!successFinalized) {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        "Native workflow runner skipped the success durability barrier"
      );
    }
  }

  private async persistRecoveryIntent(
    job: NativeStudioQueuedRun,
    reason: NativeStudioRunRecoveryReason
  ): Promise<void> {
    await this.#recoveryJournal.write(createNativeStudioRunRecoveryIntent({
      runId: job.run_id,
      executionSnapshotHash: job.execution_snapshot_hash,
      reason
    }));
  }

  private async finalize(
    lease: NativeStudioRunLease,
    storedGraph: StoredRunGraphSnapshot | undefined,
    terminal: Parameters<NativeStudioRunLease["commitTerminal"]>[0],
    lifecycleProjectionComplete: boolean,
    durableIntentSufficient = false
  ): Promise<void> {
    const state = terminal.state;
    if (state !== undefined && storedGraph === undefined) {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        "Native workflow completed without its persisted graph snapshot"
      );
    }
    await lease.commitTerminal(terminal, {
      completeness: lifecycleProjectionComplete ? "complete" : "partial",
      ...(state === undefined || storedGraph === undefined
        ? {}
        : {
            createOutcome: (recordRevision: number) =>
              projectStoredRunGraphOutcome({
                graphSnapshot: storedGraph,
                recordRevision,
                state
              })
          })
    }, async (preparation) => {
      const intent = createNativeStudioRunTerminalIntent({
        runId: preparation.projectedRecord.run_id,
        command: preparation.command,
        ...(preparation.outcome === undefined
          ? {}
          : { outcome: preparation.outcome })
      });
      if (durableIntentSufficient) {
        await this.#finalizer.commitDurableIntent(intent);
      } else {
        await this.#finalizer.commit(intent);
      }
    });
  }
}
