import type { LunaRuntimeState } from "../../../core/runtime/state.js";
import type { WorkflowRunResult } from "../../../core/workflow/execution-contracts.js";
import {
  recoverNativeWorkflowWaitingTarget,
  resumeNativeWorkflowTarget,
  type NativeWorkflowResumeInput,
  type NativeWorkflowWaitingRecoveryInput
} from "../../../platform/native/native-workflow-runner.js";
import type { NativeLunaPlatformRegistrations } from "../../../platform/native/native-platform-registrations.js";
import {
  projectStoredRunGraphOutcome,
  type RunGraphSnapshotStorePort,
  type StoredRunGraphSnapshot
} from "../../application/runs/graph-snapshot.js";
import { runStoreError } from "../../application/runs/errors.js";
import type { RunLedgerPort } from "../../application/runs/ports.js";
import type {
  RunResumeJournalPort,
  StudioRunResumeRecord
} from "../../application/runs/resume-journal.js";
import type { RunRecord } from "../../contracts/runs.js";
import type { NativeStudioRunDispatchQueue } from "../filesystem/run-dispatch-queue.js";
import type { NativeStudioRunLease } from "./run-dispatch-lease.js";
import type { NativeStudioRunFinalizer } from "./run-finalizer.js";
import {
  nativeStudioFailedTerminalIsSafeForRuntimeState,
  nativeStudioResumeNodeReplayIsSafe
} from "./run-recovery-safety.js";
import { createNativeStudioRunTerminalIntent } from "./run-terminal-intent.js";
import { nativeStudioWaitingWorkflowIdentity } from "./run-waiting-recovery.js";

export type ClaimedResumePlatform = Pick<NativeLunaPlatformRegistrations,
  | "agentRuntimeFactories" | "workflowRuntimeFactories" | "workflowBuiltIns"
  | "taskProviderBuiltIns" | "patternExecutors" | "changeRequestProviderFactories"
  | "pullRequestReviewProviderFactories" | "socialPostProviderFactories"
  | "imageGenerationProviderFactories"
  | "capabilityRegistry" | "capabilityManifests">;

export type ClaimedResumeWorkflow = (
  input: NativeWorkflowResumeInput,
  dependencies: { readonly platform: ClaimedResumePlatform }
) => Promise<WorkflowRunResult>;

export type ClaimedWaitingWorkflow = (
  input: NativeWorkflowWaitingRecoveryInput,
  dependencies: { readonly platform: ClaimedResumePlatform }
) => Promise<WorkflowRunResult>;

export type ClaimedResumeWaitingBoundary = {
  readonly id: string;
  readonly checkpoint_id: string;
};

type ResumeBarrierPhase = "idle" | "entered" | "committed";
type ResumeBarrierKind = "waiting" | "success";

type ClaimedResumeFlow =
  | { readonly kind: "complete" }
  | { readonly kind: "recovery_required"; readonly cause: unknown };

type ClaimedResumeGraph =
  | { readonly kind: "available"; readonly value: StoredRunGraphSnapshot }
  | {
      readonly kind: "invalid";
      readonly reason: "missing" | "corrupt" | "identity_mismatch";
    };

/**
 * Owns the two control-plane durability barriers crossed by a resumed run.
 * The phase model keeps an entered-but-uncommitted barrier distinct from both
 * ordinary runtime failure and a fully projected durable result.
 */
class ResumeDurabilityBarriers {
  #waiting: ResumeBarrierPhase = "idle";
  #success: ResumeBarrierPhase = "idle";

  constructor(
    private readonly lease: NativeStudioRunLease,
    private readonly finalizeSuccess: (state: LunaRuntimeState) => Promise<void>
  ) {}

  readonly onWaitingState: NonNullable<
    NativeWorkflowWaitingRecoveryInput["onWaitingState"]
  > = async (waiting) => {
    this.#waiting = this.enter("waiting", this.#waiting);
    await this.lease.waitForInput(waiting.state);
    this.#waiting = "committed";
  };

  readonly onSucceededState: NonNullable<
    NativeWorkflowResumeInput["onSucceededState"]
  > = async (state) => {
    this.#success = this.enter("success", this.#success);
    await this.finalizeSuccess(state);
    this.#success = "committed";
  };

  assertResultProjected(result: WorkflowRunResult): void {
    const phase = result.status === "waiting_for_input"
      ? this.#waiting
      : this.#success;
    if (phase === "committed") return;
    throw runStoreError(
      "run_store_corrupt",
      result.status === "waiting_for_input"
        ? "The runtime skipped its waiting durability barrier"
        : "The runtime skipped its success durability barrier"
    );
  }

  classifyFailure(cause: unknown): ClaimedResumeFlow | undefined {
    if (this.#waiting === "committed" || this.#success === "committed") {
      return { kind: "complete" };
    }
    if (this.#waiting === "entered" || this.#success === "entered") {
      return { kind: "recovery_required", cause };
    }
    return undefined;
  }

  private enter(
    kind: ResumeBarrierKind,
    phase: ResumeBarrierPhase
  ): ResumeBarrierPhase {
    if (phase !== "idle") {
      throw runStoreError(
        "run_store_corrupt",
        `The runtime invoked its ${kind} durability barrier more than once`
      );
    }
    return "entered";
  }
}

export function isNativeStudioRunConcurrencyLoss(cause: unknown): boolean {
  const code = (cause as { readonly code?: unknown })?.code;
  return code === "run_revision_conflict" ||
    code === "run_transition_invalid" ||
    code === "run_owner_conflict";
}

/**
 * Executes a hash-claimed resume command after compatibility has been proven.
 * It owns lease acquisition, runtime callbacks, durable graph projection, and
 * journal completion so the resumer only coordinates claims and recovery.
 */
export class ClaimedResumeExecutor {
  readonly #projectRoot: string;
  readonly #configRoot: string;
  readonly #ledger: RunLedgerPort;
  readonly #resumes: RunResumeJournalPort;
  readonly #queue: NativeStudioRunDispatchQueue;
  readonly #graphStore: RunGraphSnapshotStorePort;
  readonly #finalizer: NativeStudioRunFinalizer;
  readonly #platform: ClaimedResumePlatform;
  readonly #createLease: (
    job: StudioRunResumeRecord,
    onHeartbeatError: (cause: unknown) => void,
    ownerId: string | undefined
  ) => NativeStudioRunLease;
  readonly #cancelInterruptClaim: (
    job: StudioRunResumeRecord
  ) => Promise<void>;
  readonly #resumeWorkflow: ClaimedResumeWorkflow;
  readonly #recoverWaitingWorkflow: ClaimedWaitingWorkflow;

  constructor(options: {
    readonly projectRoot: string;
    readonly configRoot: string;
    readonly ledger: RunLedgerPort;
    readonly resumes: RunResumeJournalPort;
    readonly queue: NativeStudioRunDispatchQueue;
    readonly graphStore: RunGraphSnapshotStorePort;
    readonly finalizer: NativeStudioRunFinalizer;
    readonly platform: ClaimedResumePlatform;
    readonly createLease: (
      job: StudioRunResumeRecord,
      onHeartbeatError: (cause: unknown) => void,
      ownerId: string | undefined
    ) => NativeStudioRunLease;
    readonly cancelInterruptClaim: (
      job: StudioRunResumeRecord
    ) => Promise<void>;
    readonly resumeWorkflow?: ClaimedResumeWorkflow;
    readonly recoverWaitingWorkflow?: ClaimedWaitingWorkflow;
  }) {
    this.#projectRoot = options.projectRoot;
    this.#configRoot = options.configRoot;
    this.#ledger = options.ledger;
    this.#resumes = options.resumes;
    this.#queue = options.queue;
    this.#graphStore = options.graphStore;
    this.#finalizer = options.finalizer;
    this.#platform = options.platform;
    this.#createLease = options.createLease;
    this.#cancelInterruptClaim = options.cancelInterruptClaim;
    this.#resumeWorkflow = options.resumeWorkflow ?? resumeNativeWorkflowTarget;
    this.#recoverWaitingWorkflow = options.recoverWaitingWorkflow ??
      recoverNativeWorkflowWaitingTarget;
  }

  async execute(input: {
    readonly job: StudioRunResumeRecord;
    readonly record: RunRecord;
    readonly workflowMode: NativeWorkflowWaitingRecoveryInput["workflow"]["mode"];
    readonly waitingBoundary?: ClaimedResumeWaitingBoundary;
  }): Promise<void> {
    const graph = await this.readGraph(input.record);
    const controller = new AbortController();
    const recoveringRunningResume = input.record.run_status === "running";
    const lease = this.#createLease(
      input.job,
      (cause) => controller.abort(cause),
      recoveringRunningResume ? input.record.owner_id : undefined
    );
    if (!await this.acquireLease(input.job, input.record, lease)) return;
    if (graph.kind === "invalid") {
      await lease.markOutcomeUnknown({
        code: "studio_runtime_resume_graph_invalid",
        message: `Durable resume graph is ${graph.reason.replaceAll("_", " ")}`
      });
      await this.completeClaimedResume(input.job);
      return;
    }

    let failedState: LunaRuntimeState | undefined;
    const barriers = new ResumeDurabilityBarriers(
      lease,
      async (state) => await this.finalize(
        lease,
        graph.value,
        { status: "succeeded", state }
      )
    );
    const flow = await this.executeFlow({
      ...input,
      graph: graph.value,
      lease,
      controller,
      barriers,
      observeFailedState: (state) => { failedState ??= state; },
      readFailedState: () => failedState
    });
    if (flow.kind === "recovery_required") throw flow.cause;
    await this.completeClaimedResume(input.job);
  }

  private async acquireLease(
    job: StudioRunResumeRecord,
    record: RunRecord,
    lease: NativeStudioRunLease
  ): Promise<boolean> {
    const recoveringRunningResume = record.run_status === "running";
    try {
      if (record.run_status === "waiting_for_input") await lease.prepareResume();
      const current = await this.#ledger.get(job.run_id);
      if (recoveringRunningResume) {
        if (
          current?.run_status !== "running" ||
          current.owner_id !== record.owner_id
        ) return false;
        lease.startHeartbeat();
      } else {
        if (current?.run_status !== "resuming") return false;
        await lease.startResume();
      }
      return true;
    } catch (cause) {
      if (isNativeStudioRunConcurrencyLoss(cause)) return false;
      throw cause;
    }
  }

  private async executeFlow(input: {
    readonly job: StudioRunResumeRecord;
    readonly record: RunRecord;
    readonly workflowMode: NativeWorkflowWaitingRecoveryInput["workflow"]["mode"];
    readonly waitingBoundary?: ClaimedResumeWaitingBoundary;
    readonly graph: StoredRunGraphSnapshot;
    readonly lease: NativeStudioRunLease;
    readonly controller: AbortController;
    readonly barriers: ResumeDurabilityBarriers;
    readonly observeFailedState: (state: LunaRuntimeState) => void;
    readonly readFailedState: () => LunaRuntimeState | undefined;
  }): Promise<ClaimedResumeFlow> {
    try {
      const result = await this.invokeWorkflow(input);
      if (input.lease.hasHeartbeatFailure()) {
        throw input.lease.heartbeatFailure();
      }
      input.barriers.assertResultProjected(result);
      return { kind: "complete" };
    } catch (cause) {
      const barrierFlow = input.barriers.classifyFailure(cause);
      if (barrierFlow !== undefined) return barrierFlow;
      await this.finalizePreBarrierFailure(
        input.job,
        input.record,
        input.graph,
        input.lease,
        input.readFailedState(),
        cause
      );
      return { kind: "complete" };
    }
  }

  private async invokeWorkflow(input: {
    readonly job: StudioRunResumeRecord;
    readonly record: RunRecord;
    readonly workflowMode: NativeWorkflowWaitingRecoveryInput["workflow"]["mode"];
    readonly waitingBoundary?: ClaimedResumeWaitingBoundary;
    readonly graph: StoredRunGraphSnapshot;
    readonly lease: NativeStudioRunLease;
    readonly controller: AbortController;
    readonly barriers: ResumeDurabilityBarriers;
    readonly observeFailedState: (state: LunaRuntimeState) => void;
  }): Promise<WorkflowRunResult> {
    const common = {
      projectRoot: this.#projectRoot,
      configRoot: this.#configRoot,
      definitionRoots: this.#queue.snapshotRootsFor(input.job.run_id),
      thread_id: input.job.thread_id,
      signal: input.controller.signal,
      onWaitingState: input.barriers.onWaitingState
    } as const;
    if (input.waitingBoundary !== undefined) {
      return await this.#recoverWaitingWorkflow({
        ...common,
        workflow: nativeStudioWaitingWorkflowIdentity(
          input.graph,
          input.workflowMode
        ),
        checkpoint_id: input.waitingBoundary.checkpoint_id,
        interrupt_id: input.waitingBoundary.id
      }, { platform: this.#platform });
    }
    return await this.#resumeWorkflow({
      ...common,
      target: { type: "workflow", id: input.job.workflow_id },
      checkpoint_id: input.job.checkpoint_id,
      interrupt_id: input.job.interrupt_id,
      decision: input.job.decision,
      onFailedState: input.observeFailedState,
      onBeforeNodeExecution: async ({ node_id: nodeId }) => {
        if (!nativeStudioResumeNodeReplayIsSafe(input.record.side_effects, nodeId)) {
          await this.#resumes.markEffectMayHaveOccurred({
            resume_id: input.job.resume_id,
            command_hash: input.job.command_hash,
            node_id: nodeId
          });
        }
      },
      onLifecycleEvent: async (event) => {
        await input.lease.observeNode(event);
      },
      onSucceededState: input.barriers.onSucceededState
    }, { platform: this.#platform });
  }

  private async finalizePreBarrierFailure(
    job: StudioRunResumeRecord,
    record: RunRecord,
    graph: StoredRunGraphSnapshot,
    lease: NativeStudioRunLease,
    failedState: LunaRuntimeState | undefined,
    cause: unknown
  ): Promise<void> {
    const resumeWasPreExecution = await this.resumeWasProvenPreExecution(job);
    if (
      !resumeWasPreExecution &&
      record.side_effects.length > 0 &&
      (failedState === undefined ||
        !nativeStudioFailedTerminalIsSafeForRuntimeState(record.side_effects, failedState))
    ) {
      await lease.markOutcomeUnknown({
        code: "studio_runtime_write_outcome_unknown",
        message: "A resumed write-capable run ended without proof of its external outcome"
      });
      return;
    }
    await this.finalize(lease, graph, {
      status: "failed",
      ...(failedState === undefined ? {} : { state: failedState }),
      cause
    });
  }

  private async resumeWasProvenPreExecution(
    job: StudioRunResumeRecord
  ): Promise<boolean> {
    try {
      const current = await this.#resumes.get(job.resume_id);
      return current !== undefined &&
        current.command_hash === job.command_hash &&
        current.run_id === job.run_id &&
        current.interrupt_id === job.interrupt_id &&
        current.stage.kind === "pre_execution";
    } catch {
      // An unavailable or corrupt authority cannot prove that execution stayed
      // behind the effect barrier, so terminal classification remains closed.
      return false;
    }
  }

  private async completeClaimedResume(
    job: StudioRunResumeRecord
  ): Promise<void> {
    // The journal tombstone must never outlive a dangling resuming claim.
    // Resolved claims are validated and preserved by the callback; an exact
    // unresolved claim is cancelled before the command loses recovery status.
    await this.#cancelInterruptClaim(job);
    await this.#resumes.complete({
      resume_id: job.resume_id,
      command_hash: job.command_hash
    });
  }

  private async readGraph(
    record: RunRecord
  ): Promise<ClaimedResumeGraph> {
    const handle = record.graph_snapshot_handle;
    if (handle === undefined) {
      return { kind: "invalid", reason: "missing" };
    }
    const graph = await this.#graphStore.readGraph(handle);
    if (graph.kind === "unavailable") {
      throw runStoreError(
        "run_store_io_failed",
        "The durable resume graph store is unavailable"
      );
    }
    if (graph.kind === "missing" || graph.kind === "corrupt") {
      return { kind: "invalid", reason: graph.kind };
    }
    const identity = graph.value.identity;
    if (
      identity.graph_snapshot_handle !== handle ||
      identity.run_id !== record.run_id ||
      identity.workflow_id !== record.workflow_id ||
      identity.workflow_revision !== record.workflow_revision ||
      identity.definition_bundle_hash !== record.definition_bundle_hash ||
      identity.execution_snapshot_hash !== record.execution_snapshot_hash
    ) {
      return { kind: "invalid", reason: "identity_mismatch" };
    }
    return graph;
  }

  private async finalize(
    lease: NativeStudioRunLease,
    graph: StoredRunGraphSnapshot,
    terminal: Parameters<NativeStudioRunLease["commitTerminal"]>[0]
  ): Promise<void> {
    await lease.commitTerminal(terminal, {
      completeness: "complete",
      ...(terminal.state === undefined ? {} : {
        createOutcome: (recordRevision: number) => projectStoredRunGraphOutcome({
          graphSnapshot: graph,
          recordRevision,
          state: terminal.state!
        })
      })
    }, async (preparation) => {
      await this.#finalizer.commitDurableIntent(createNativeStudioRunTerminalIntent({
        runId: preparation.projectedRecord.run_id,
        command: preparation.command,
        ...(preparation.outcome === undefined ? {} : {
          outcome: preparation.outcome
        })
      }));
    });
  }
}
