import type { JsonValue } from "../../../core/runtime/json.js";
import { stableJson } from "../../../core/runtime/json.js";
import type { InterruptStore } from "../../../core/runtime/interrupts/contracts.js";
import type { InterruptResumeClaim, ResumeInput } from "../../../core/runtime/interrupts/contracts.js";
import {
  normalizeResumeInput,
  resumeInputsEqual
} from "../../../core/runtime/interrupts/resume.js";
import type { LunaRuntimeState } from "../../../core/runtime/state.js";
import type { WorkflowRunResult } from "../../../core/workflow/execution-contracts.js";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import { resumeNativeWorkflowTarget, type NativeWorkflowResumeInput } from "../../../platform/native/native-workflow-runner.js";
import type { NativeLunaPlatformRegistrations } from "../../../platform/native/native-platform-registrations.js";
import { projectStoredRunGraphOutcome, type RunGraphSnapshotStorePort, type StoredRunGraphSnapshot } from "../../application/runs/graph-snapshot.js";
import type { StudioRunInterruptResumePort } from "../../application/runs/interrupt-service.js";
import { runStoreError } from "../../application/runs/errors.js";
import type { RunLedgerPort } from "../../application/runs/ports.js";
import type { StudioRunInterruptResumeReceipt } from "../../contracts/run-interrupts.js";
import { RunTerminalStatusSchema } from "../../contracts/runs.js";
import {
  isNativeStudioRunDispatchQueueCorruption,
  type NativeStudioRunDispatchQueue
} from "../filesystem/run-dispatch-queue.js";
import type { NativeStudioQueuedResume } from "../filesystem/run-resume-contracts.js";
import { NativeStudioRunFinalizer } from "./run-finalizer.js";
import { NativeStudioRunLease } from "./run-dispatch-lease.js";
import { nativeStudioFailedTerminalIsSafeForRuntimeState } from "./run-recovery-safety.js";
import { createNativeStudioRunTerminalIntent } from "./run-terminal-intent.js";
import { createNativeStudioCapabilityCatalog } from "./capability-catalog.js";
import { assertNativeStudioResumeMaterialCompatible } from "./run-resume-compatibility.js";
import {
  StudioRunResumeError,
  studioRunResumeCatalogChanged
} from "../../application/runs/resume-errors.js";

type ResumePlatform = Pick<NativeLunaPlatformRegistrations,
  | "agentRuntimeFactories" | "workflowRuntimeFactories" | "workflowBuiltIns"
  | "taskProviderBuiltIns" | "patternExecutors" | "changeRequestProviderFactories"
  | "pullRequestReviewProviderFactories" | "socialPostProviderFactories"
  | "imageGenerationProviderFactories"
  | "capabilityRegistry" | "capabilityManifests">;

type ResumeWorkflow = (
  input: NativeWorkflowResumeInput,
  dependencies: { readonly platform: ResumePlatform }
) => Promise<WorkflowRunResult>;

function isConcurrencyLoss(cause: unknown): boolean {
  const code = (cause as { readonly code?: unknown })?.code;
  return code === "run_revision_conflict" ||
    code === "run_transition_invalid" ||
    code === "run_owner_conflict";
}

export class NativeStudioRunInterruptResumer implements StudioRunInterruptResumePort {
  readonly #projectRoot: string;
  readonly #configRoot: string;
  readonly #ledger: RunLedgerPort;
  readonly #interrupts: Pick<InterruptStore, "get" | "beginResume" | "completeResume">;
  readonly #queue: NativeStudioRunDispatchQueue;
  readonly #graphStore: RunGraphSnapshotStorePort;
  readonly #finalizer: NativeStudioRunFinalizer;
  readonly #platform: ResumePlatform;
  readonly #now: () => number;
  readonly #heartbeatIntervalMs: number;
  readonly #schedule: (resumeId: string) => void;
  readonly #onBackgroundError: (cause: unknown) => void;
  readonly #resumeWorkflow: ResumeWorkflow;

  constructor(options: {
    readonly projectRoot: string;
    readonly configRoot: string;
    readonly ledger: RunLedgerPort;
    readonly interrupts: Pick<InterruptStore, "get" | "beginResume" | "completeResume">;
    readonly queue: NativeStudioRunDispatchQueue;
    readonly graphStore: RunGraphSnapshotStorePort;
    readonly finalizer: NativeStudioRunFinalizer;
    readonly platform: ResumePlatform;
    readonly schedule: (resumeId: string) => void;
    readonly onBackgroundError: (cause: unknown) => void;
    readonly resumeWorkflow?: ResumeWorkflow;
    readonly now?: () => number;
    readonly heartbeatIntervalMs?: number;
  }) {
    this.#projectRoot = options.projectRoot;
    this.#configRoot = options.configRoot;
    this.#ledger = options.ledger;
    this.#interrupts = options.interrupts;
    this.#queue = options.queue;
    this.#graphStore = options.graphStore;
    this.#finalizer = options.finalizer;
    this.#platform = options.platform;
    this.#schedule = options.schedule;
    this.#onBackgroundError = options.onBackgroundError;
    this.#resumeWorkflow = options.resumeWorkflow ?? resumeNativeWorkflowTarget;
    this.#now = options.now ?? Date.now;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
  }

  async resume(input: Parameters<StudioRunInterruptResumePort["resume"]>[0]): Promise<StudioRunInterruptResumeReceipt> {
    const desiredDecision: JsonValue = input.decision;
    const existing = input.interrupt.resume;
    if (existing !== undefined) {
      if (stableJson(existing.decision) !== stableJson(desiredDecision)) {
        throw runStoreError("run_idempotency_conflict", "The interrupt was resumed with a different decision");
      }
      return await this.existingReceipt(input.runId, input.interrupt.id);
    }
    if (
      input.interrupt.resume_input !== undefined &&
      stableJson(input.interrupt.resume_input.decision) !== stableJson(desiredDecision)
    ) {
      throw runStoreError("run_idempotency_conflict", "The interrupt is resuming with a different decision");
    }
    if (input.interrupt.resume_input !== undefined) {
      return await this.existingReceipt(input.runId, input.interrupt.id);
    }

    const record = await this.#ledger.get(input.runId);
    if (record === undefined) throw runStoreError("run_not_found", "The requested run does not exist");
    if (
      record.owner_id === undefined ||
      record.execution_snapshot_hash === undefined ||
      (record.run_status !== "waiting_for_input" &&
        record.run_status !== "resuming")
    ) {
      throw runStoreError("run_transition_invalid", "The run cannot accept this interrupt decision");
    }
    const sourceJob = await this.#queue.read(input.runId);
    assertNativeStudioResumeMaterialCompatible({
      sourceExecutionSnapshotHash: sourceJob.execution_snapshot_hash,
      recordExecutionSnapshotHash: record.execution_snapshot_hash,
      sourceCatalogFingerprint: sourceJob.catalog_fingerprint,
      recordCatalogFingerprint: record.catalog_fingerprint,
      currentCatalogFingerprint: createNativeStudioCapabilityCatalog(this.#platform).technical_fingerprint
    });
    const resumeId = `resume-${sha256Digest({
      schema_version: 1,
      run_id: input.runId,
      interrupt_id: input.interrupt.id
    })}`;
    let accepted;
    try {
      accepted = await this.#queue.acceptResume({
        schema_version: 1,
        resume_id: resumeId,
        run_id: input.runId,
        interrupt_id: input.interrupt.id,
        thread_id: input.interrupt.thread_id ?? input.runId,
        checkpoint_id: input.interrupt.payload!.checkpoint_id,
        workflow_id: record.workflow_id,
        owner_id: record.owner_id,
        execution_snapshot_hash: record.execution_snapshot_hash,
        decision: desiredDecision,
        decision_hash: sha256Digest(desiredDecision),
        accepted_at: new Date(this.#now()).toISOString()
      });
    } catch (cause) {
      const queued = await this.#queue.readResume(resumeId).catch(() => undefined);
      if (queued !== undefined && stableJson(queued.decision) !== stableJson(desiredDecision)) {
        throw runStoreError("run_idempotency_conflict", "The interrupt was queued with a different decision");
      }
      throw cause;
    }
    await this.claimInterrupt(accepted.job);

    if (record.run_status === "waiting_for_input") {
      const lease = this.lease(accepted.job);
      try {
        await lease.prepareResume();
      } catch (cause) {
        if (!isConcurrencyLoss(cause)) throw cause;
      }
    }
    this.#schedule(resumeId);
    return {
      accepted: true,
      run_id: input.runId,
      interrupt_id: input.interrupt.id,
      resume_status: "resuming",
      already_resumed: false
    };
  }

  private async claimInterrupt(job: NativeStudioQueuedResume): Promise<void> {
    const resumeInput: ResumeInput = normalizeResumeInput({
      interrupt_id: job.interrupt_id,
      thread_id: job.thread_id,
      checkpoint_id: job.checkpoint_id,
      decision: job.decision
    });
    const current = await this.#interrupts.get(job.interrupt_id);
    if (current === undefined) {
      throw runStoreError("run_not_found", "The requested interrupt does not exist");
    }
    if (current.status === "resuming") {
      if (
        current.resume_attempt !== job.resume_id ||
        current.resume_input === undefined ||
        !resumeInputsEqual(current.resume_input, resumeInput)
      ) {
        throw runStoreError("run_idempotency_conflict", "The interrupt is resuming with a different decision");
      }
      return;
    }
    if (current.status !== "pending") {
      throw runStoreError("run_transition_invalid", "The interrupt cannot accept a resume claim");
    }
    try {
      await this.#interrupts.beginResume(
        job.interrupt_id,
        job.resume_id,
        resumeInput
      );
    } catch (cause) {
      const accepted = await this.#interrupts.get(job.interrupt_id);
      if (
        accepted?.status === "resuming" &&
        accepted.resume_attempt === job.resume_id &&
        accepted.resume_input !== undefined &&
        resumeInputsEqual(accepted.resume_input, resumeInput)
      ) {
        return;
      }
      throw cause;
    }
  }

  async recoverAvailableJobs(): Promise<ReadonlySet<string>> {
    const protectedRunIds = new Set<string>();
    for (const resumeId of await this.#queue.listResumeIds()) {
      try {
        const protectedRunId = await this.recoverAvailableJob(resumeId);
        if (protectedRunId !== undefined) {
          protectedRunIds.add(protectedRunId);
        }
      } catch (cause) {
        if (isNativeStudioRunDispatchQueueCorruption(cause)) {
          try {
            await this.#queue.quarantineResume(resumeId);
          } catch (quarantineCause) {
            this.#onBackgroundError(quarantineCause);
            continue;
          }
        }
        this.#onBackgroundError(cause);
      }
    }
    return protectedRunIds;
  }

  private async recoverAvailableJob(resumeId: string): Promise<string | undefined> {
    const job = await this.#queue.readResume(resumeId);
    const [record, interrupt] = await Promise.all([
      this.#ledger.get(job.run_id),
      this.#interrupts.get(job.interrupt_id)
    ]);
    if (
      record === undefined ||
      interrupt === undefined ||
      interrupt.status === "cancelled" ||
      (record.run_status !== undefined && RunTerminalStatusSchema.safeParse(record.run_status).success)
    ) {
      await this.#queue.removeResume(resumeId);
      return undefined;
    }
    if (interrupt.resume !== undefined) {
      if (stableJson(interrupt.resume.decision) !== stableJson(job.decision)) {
        throw runStoreError("run_store_corrupt", "A durable resume decision conflicts with the interrupt record");
      }
      await this.#queue.removeResume(resumeId);
      return undefined;
    }
    if (record.run_status === "waiting_for_input" || record.run_status === "resuming") {
      this.#schedule(resumeId);
      return job.run_id;
    }
    return undefined;
  }

  async execute(resumeId: string): Promise<void> {
    const job = await this.#queue.readResume(resumeId);
    const [record, interrupt, sourceJob] = await Promise.all([
      this.#ledger.get(job.run_id),
      this.#interrupts.get(job.interrupt_id),
      this.#queue.read(job.run_id)
    ]);
    if (record === undefined || interrupt === undefined) {
      await this.#queue.removeResume(resumeId);
      return;
    }
    if (interrupt.resume !== undefined) {
      if (stableJson(interrupt.resume.decision) !== stableJson(job.decision)) {
        throw runStoreError("run_store_corrupt", "A durable resume decision conflicts with the interrupt record");
      }
      await this.#queue.removeResume(resumeId);
      return;
    }
    assertNativeStudioResumeMaterialCompatible({
      sourceExecutionSnapshotHash: sourceJob.execution_snapshot_hash,
      recordExecutionSnapshotHash: record.execution_snapshot_hash ?? "",
      acceptedResumeExecutionSnapshotHash: job.execution_snapshot_hash,
      sourceCatalogFingerprint: sourceJob.catalog_fingerprint,
      recordCatalogFingerprint: record.catalog_fingerprint,
      currentCatalogFingerprint: createNativeStudioCapabilityCatalog(this.#platform).technical_fingerprint
    });

    const graph = await this.readGraph(record.graph_snapshot_handle);
    const controller = new AbortController();
    const lease = this.lease(job, (cause) => controller.abort(cause));
    try {
      if (record.run_status === "waiting_for_input") await lease.prepareResume();
      const current = await this.#ledger.get(job.run_id);
      if (current?.run_status !== "resuming") return;
      await lease.startResume();
    } catch (cause) {
      if (isConcurrencyLoss(cause)) return;
      throw cause;
    }

    let failedState: LunaRuntimeState | undefined;
    let waitBarrierCrossed = false;
    let successBarrierAttempted = false;
    let successFinalized = false;
    try {
      const result = await this.#resumeWorkflow({
        projectRoot: this.#projectRoot,
        configRoot: this.#configRoot,
        definitionRoots: this.#queue.snapshotRootsFor(job.run_id),
        target: { type: "workflow", id: job.workflow_id },
        thread_id: job.thread_id,
        checkpoint_id: job.checkpoint_id,
        interrupt_id: job.interrupt_id,
        decision: job.decision,
        signal: controller.signal,
        onFailedState: (state) => { failedState ??= state; },
        onLifecycleEvent: async (event) => { await lease.observeNode(event); },
        onSucceededState: async (state) => {
          if (successBarrierAttempted) {
            throw runStoreError("run_store_corrupt", "The runtime invoked its success durability barrier more than once");
          }
          successBarrierAttempted = true;
          await this.finalize(lease, graph, { status: "succeeded", state }, true);
          successFinalized = true;
        }
      }, { platform: this.#platform });
      if (lease.hasHeartbeatFailure()) throw lease.heartbeatFailure();
      waitBarrierCrossed = result.status === "waiting_for_input";
      if (result.status === "waiting_for_input") {
        await lease.waitForInput(result.state);
      } else if (!successFinalized) {
        throw runStoreError("run_store_corrupt", "The runtime skipped its success durability barrier");
      }
      await this.#queue.removeResume(resumeId);
    } catch (cause) {
      if (successFinalized) {
        await this.#queue.removeResume(resumeId);
        return;
      }
      if (successBarrierAttempted || waitBarrierCrossed) {
        // The runtime already crossed a durable checkpoint/terminal boundary.
        // Preserve the queued command for journal/orphan recovery instead of
        // manufacturing a contradictory failure.
        throw cause;
      }
      if (
        record.side_effects.length > 0 &&
        (failedState === undefined ||
          !nativeStudioFailedTerminalIsSafeForRuntimeState(record.side_effects, failedState))
      ) {
        await lease.markOutcomeUnknown({ code: "studio_runtime_write_outcome_unknown", message: "A resumed write-capable run ended without proof of its external outcome" });
      } else {
        await this.finalize(lease, graph, { status: "failed", ...(failedState === undefined ? {} : { state: failedState }), cause }, true);
      }
      await this.#queue.removeResume(resumeId);
    }
  }

  private lease(
    job: NativeStudioQueuedResume,
    onHeartbeatError?: (cause: unknown) => void
  ): NativeStudioRunLease {
    return new NativeStudioRunLease({
      ledger: this.#ledger,
      runId: job.run_id,
      ownerId: job.owner_id,
      now: this.#now,
      heartbeatIntervalMs: this.#heartbeatIntervalMs,
      lifecycleExecutionId: job.resume_id,
      ...(onHeartbeatError === undefined ? {} : { onHeartbeatError })
    });
  }

  private async existingReceipt(runId: string, interruptId: string): Promise<StudioRunInterruptResumeReceipt> {
    const item = await this.#ledger.get(runId);
    const status = item?.run_status;
    return {
      accepted: true,
      run_id: runId,
      interrupt_id: interruptId,
      resume_status: status === "succeeded" || status === "failed" || status === "waiting_for_input"
        ? status
        : "resuming",
      already_resumed: true
    };
  }

  private async readGraph(handle: string | undefined): Promise<StoredRunGraphSnapshot> {
    if (handle === undefined) throw runStoreError("run_store_corrupt", "The run graph snapshot is unavailable");
    const graph = await this.#graphStore.readGraph(handle);
    if (graph.kind !== "available") throw runStoreError("run_store_corrupt", "The run graph snapshot is unavailable");
    return graph.value;
  }

  private async finalize(
    lease: NativeStudioRunLease,
    graph: StoredRunGraphSnapshot,
    terminal: Parameters<NativeStudioRunLease["commitTerminal"]>[0],
    lifecycleProjectionComplete: boolean
  ): Promise<void> {
    await lease.commitTerminal(terminal, {
      completeness: lifecycleProjectionComplete ? "complete" : "partial",
      ...(terminal.state === undefined ? {} : {
        createOutcome: (recordRevision: number) => projectStoredRunGraphOutcome({ graphSnapshot: graph, recordRevision, state: terminal.state! })
      })
    }, async (preparation) => {
      await this.#finalizer.commitDurableIntent(createNativeStudioRunTerminalIntent({
        runId: preparation.projectedRecord.run_id,
        command: preparation.command,
        ...(preparation.outcome === undefined ? {} : { outcome: preparation.outcome })
      }));
    });
  }
}
