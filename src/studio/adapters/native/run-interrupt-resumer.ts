import type { JsonValue } from "../../../core/runtime/json.js";
import { stableJson } from "../../../core/runtime/json.js";
import type {
  InterruptRecord,
  InterruptResumeClaim,
  InterruptStore
} from "../../../core/runtime/interrupts/contracts.js";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import type { RunGraphSnapshotStorePort } from "../../application/runs/graph-snapshot.js";
import type { StudioRunInterruptResumePort } from "../../application/runs/interrupt-service.js";
import { runStoreError } from "../../application/runs/errors.js";
import type { RunLedgerPort } from "../../application/runs/ports.js";
import type {
  RunResumeJournalPort,
  StudioRunResumeRecord
} from "../../application/runs/resume-journal.js";
import {
  StudioRunResumeError,
  studioRunResumeCatalogChanged
} from "../../application/runs/resume-errors.js";
import type { StudioRunInterruptResumeReceipt } from "../../contracts/run-interrupts.js";
import {
  RunTerminalStatusSchema,
  type RunRecord
} from "../../contracts/runs.js";
import {
  isNativeStudioRunDispatchQueueCorruption,
  type NativeStudioRunDispatchQueue
} from "../filesystem/run-dispatch-queue.js";
import {
  ClaimedResumeExecutor,
  isNativeStudioRunConcurrencyLoss,
  type ClaimedResumePlatform as ResumePlatform,
  type ClaimedResumeWorkflow as ResumeWorkflow,
  type ClaimedWaitingWorkflow as RecoverWaitingWorkflow
} from "./claimed-resume-executor.js";
import { NativeStudioRunFinalizer } from "./run-finalizer.js";
import { NativeStudioRunLease } from "./run-dispatch-lease.js";
import { createNativeStudioRunTerminalIntent } from "./run-terminal-intent.js";
import { createNativeStudioCapabilityCatalog } from "./capability-catalog.js";
import { assertNativeStudioResumeMaterialCompatible } from "./run-resume-compatibility.js";
import { recoverNativeStudioRunningResume } from "./run-resume-running-recovery.js";
import {
  assertNativeStudioResolvedResumeMatchesJob,
  ensureNativeStudioResumeInterruptClaim
} from "./run-resume-interrupt-claim.js";

type DurablePendingInterrupt = InterruptRecord & {
  readonly thread_id: string;
  readonly checkpoint_id: string;
};

export class NativeStudioRunInterruptResumer implements StudioRunInterruptResumePort {
  readonly #ledger: RunLedgerPort;
  readonly #interrupts: Pick<
    InterruptStore,
    "get" | "findFirst" | "beginResume" | "completeResume"
  >;
  readonly #resumes: RunResumeJournalPort;
  readonly #queue: NativeStudioRunDispatchQueue;
  readonly #finalizer: NativeStudioRunFinalizer;
  readonly #platform: ResumePlatform;
  readonly #ownerId: string;
  readonly #now: () => number;
  readonly #heartbeatIntervalMs: number;
  readonly #orphanThresholdMs: number;
  readonly #schedule: (resumeId: string) => void;
  readonly #onBackgroundError: (cause: unknown) => void;
  readonly #claimedResumeExecutor: ClaimedResumeExecutor;

  constructor(options: {
    readonly projectRoot: string;
    readonly configRoot: string;
    readonly ledger: RunLedgerPort;
    readonly interrupts: Pick<
      InterruptStore,
      "get" | "findFirst" | "beginResume" | "completeResume"
    >;
    readonly resumes: RunResumeJournalPort;
    readonly queue: NativeStudioRunDispatchQueue;
    readonly graphStore: RunGraphSnapshotStorePort;
    readonly finalizer: NativeStudioRunFinalizer;
    readonly platform: ResumePlatform;
    readonly ownerId: string;
    readonly orphanThresholdMs: number;
    readonly schedule: (resumeId: string) => void;
    readonly onBackgroundError: (cause: unknown) => void;
    readonly resumeWorkflow?: ResumeWorkflow;
    readonly recoverWaitingWorkflow?: RecoverWaitingWorkflow;
    readonly now?: () => number;
    readonly heartbeatIntervalMs?: number;
  }) {
    this.#ledger = options.ledger;
    this.#interrupts = options.interrupts;
    this.#resumes = options.resumes;
    this.#queue = options.queue;
    this.#finalizer = options.finalizer;
    this.#platform = options.platform;
    this.#ownerId = options.ownerId;
    this.#schedule = options.schedule;
    this.#onBackgroundError = options.onBackgroundError;
    this.#now = options.now ?? Date.now;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.#orphanThresholdMs = options.orphanThresholdMs;
    this.#claimedResumeExecutor = new ClaimedResumeExecutor({
      projectRoot: options.projectRoot,
      configRoot: options.configRoot,
      ledger: options.ledger,
      resumes: options.resumes,
      queue: options.queue,
      graphStore: options.graphStore,
      finalizer: options.finalizer,
      platform: options.platform,
      createLease: (job, onHeartbeatError, ownerId) =>
        this.lease(job, onHeartbeatError, ownerId),
      cancelInterruptClaim: async (job) =>
        await this.cancelInterruptClaim(job),
      ...(options.resumeWorkflow === undefined
        ? {}
        : { resumeWorkflow: options.resumeWorkflow }),
      ...(options.recoverWaitingWorkflow === undefined
        ? {}
        : { recoverWaitingWorkflow: options.recoverWaitingWorkflow })
    });
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
      accepted = await this.#resumes.accept({
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
      const queued = await this.#resumes.get(resumeId).catch(() => undefined);
      if (queued !== undefined && stableJson(queued.decision) !== stableJson(desiredDecision)) {
        throw runStoreError("run_idempotency_conflict", "The interrupt was queued with a different decision");
      }
      throw cause;
    }
    if (accepted.record.stage.kind === "completed") {
      return await this.existingReceipt(input.runId, input.interrupt.id);
    }
    await this.claimInterrupt(accepted.record);

    if (record.run_status === "waiting_for_input") {
      const lease = this.lease(accepted.record);
      try {
        await lease.prepareResume();
      } catch (cause) {
        if (!isNativeStudioRunConcurrencyLoss(cause)) throw cause;
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

  private async claimInterrupt(job: StudioRunResumeRecord): Promise<void> {
    await ensureNativeStudioResumeInterruptClaim(this.#interrupts, job);
  }

  async recoverAvailableJobs(): Promise<ReadonlySet<string>> {
    const protectedRunIds = new Set<string>();
    for (const job of await this.#resumes.list()) {
      try {
        const protectedRunId = await this.recoverAvailableJob(job);
        if (protectedRunId !== undefined) {
          protectedRunIds.add(protectedRunId);
        }
      } catch (cause) {
        // A valid journal row remains authoritative after transient failures.
        protectedRunIds.add(job.run_id);
        this.#onBackgroundError(cause);
      }
    }
    return protectedRunIds;
  }

  private async recoverAvailableJob(job: StudioRunResumeRecord): Promise<string | undefined> {
    const [record, interrupt] = await Promise.all([
      this.#ledger.get(job.run_id),
      this.#interrupts.get(job.interrupt_id)
    ]);
    if (record === undefined) {
      await this.completeResumeJob(job);
      return undefined;
    }
    if (interrupt === undefined) {
      await this.convergeMissingResumeDependency(job, record, "interrupt");
      return undefined;
    }
    if (
      record.run_status !== undefined &&
      RunTerminalStatusSchema.safeParse(record.run_status).success
    ) {
      await this.cancelInterruptClaim(job);
      await this.completeResumeJob(job);
      return undefined;
    }
    if (interrupt.status === "cancelled") {
      await this.cancelRunBeforeResume(job, new Error(
        "The accepted interrupt decision was cancelled before runtime resume"
      ));
      if (await this.resumeStillNeedsRecovery(job)) return job.run_id;
      await this.completeResumeJob(job);
      return undefined;
    }
    if (interrupt.resume !== undefined) {
      assertNativeStudioResolvedResumeMatchesJob(job, interrupt.resume);
      if (
        record.run_status !== "running" &&
        record.run_status !== "resuming"
      ) {
        // A later wait barrier is already durable. The old resume command has
        // converged and must not be replayed over the next interrupt.
        await this.completeResumeJob(job);
        return undefined;
      }
    }
    // Queue acceptance and the resume stage are durable before the interrupt
    // claim. A process can die in that window, so recovery must re-establish
    // the exact hash-bound claim before it can mutate run ownership or enqueue
    // execution. claimInterrupt is idempotent for the same resume command and
    // fails closed for every conflicting attempt.
    await this.claimInterrupt(job);
    const sourceJob = await this.readResumeSourceOrConverge(job, record);
    if (sourceJob === undefined) return undefined;
    if (record.run_status === "running") {
      const waitingBoundary = await this.pendingInterruptAfterResume(job);
      return await recoverNativeStudioRunningResume(job, record, {
        queue: this.#queue,
        ledger: this.#ledger,
        now: this.#now,
        orphanThresholdMs: this.#orphanThresholdMs,
        waitingBoundaryDurable: waitingBoundary !== undefined,
        createRecoveryLease: (candidate) =>
          this.lease(candidate, undefined, this.#ownerId),
        assertCompatible: (candidate, candidateRecord, sourceJob) =>
          this.assertResumeCompatible(candidate, candidateRecord, sourceJob),
        cancelClaimed: async (candidate, lease, cause) =>
          await this.cancelClaimedRunningResume(candidate, lease, cause),
        markUnknown: async (candidate, lease, code, message) =>
          await this.markClaimedRunningResumeUnknown(
            candidate,
            lease,
            code,
            message
          ),
        schedule: this.#schedule
      });
    }
    if (record.run_status === "waiting_for_input" || record.run_status === "resuming") {
      try {
        this.assertResumeCompatible(job, record, sourceJob);
      } catch (cause) {
        if (!(cause instanceof StudioRunResumeError)) throw cause;
        await this.convergeCatalogDrift(job);
        return await this.resumeStillNeedsRecovery(job) ? job.run_id : undefined;
      }
      this.#schedule(job.resume_id);
      return job.run_id;
    }
    return undefined;
  }

  async execute(resumeId: string): Promise<void> {
    const candidate = await this.#resumes.get(resumeId);
    if (candidate === undefined || candidate.stage.kind === "completed") return;
    const job = await this.#resumes.get(resumeId);
    if (
      job === undefined ||
      job.stage.kind === "completed" ||
      job.command_hash !== candidate.command_hash
    ) return;

    // The workflow runtime is the sole owner of the per-run resume lease.
    // Holding that same filesystem lease in Studio while invoking the runtime
    // deadlocks the non-reentrant lock until its acquisition timeout. Studio
    // already serializes scheduled resume jobs by resume id, while the journal,
    // interrupt claim, and ledger CAS provide durable cross-process authority.
    await this.executeClaimed(job);
  }

  private async executeClaimed(job: StudioRunResumeRecord): Promise<void> {
    const [record, interrupt] = await Promise.all([
      this.#ledger.get(job.run_id),
      this.#interrupts.get(job.interrupt_id)
    ]);
    if (record === undefined) {
      await this.completeResumeJob(job);
      return;
    }
    if (interrupt === undefined) {
      await this.convergeMissingResumeDependency(job, record, "interrupt");
      return;
    }
    if (interrupt.resume !== undefined) {
      assertNativeStudioResolvedResumeMatchesJob(job, interrupt.resume);
      if (
        record.run_status !== "running" &&
        record.run_status !== "resuming"
      ) {
        await this.completeResumeJob(job);
        return;
      }
    }
    // execute() is also a trust boundary: recovery scheduling is deliberately
    // at-least-once, so never rely on the caller having claimed the interrupt.
    // This closes the accepted+staged crash window before any ledger
    // transition or workflow code can run.
    await this.claimInterrupt(job);
    const sourceJob = await this.readResumeSourceOrConverge(job, record);
    if (sourceJob === undefined) return;
    const waitingBoundary = record.run_status === "running"
      ? await this.pendingInterruptAfterResume(job)
      : undefined;
    try {
      if (waitingBoundary === undefined) {
        this.assertResumeCompatible(job, record, sourceJob);
      }
    } catch (cause) {
      if (!(cause instanceof StudioRunResumeError)) throw cause;
      await this.convergeCatalogDrift(job);
      return;
    }

    await this.#claimedResumeExecutor.execute({
      job,
      record,
      workflowMode: sourceJob.execution_snapshot.mode,
      ...(waitingBoundary === undefined ? {} : { waitingBoundary })
    });
  }

  private assertResumeCompatible(
    job: StudioRunResumeRecord,
    record: NonNullable<Awaited<ReturnType<RunLedgerPort["get"]>>>,
    sourceJob: Awaited<ReturnType<NativeStudioRunDispatchQueue["read"]>>
  ): void {
    assertNativeStudioResumeMaterialCompatible({
      sourceExecutionSnapshotHash: sourceJob.execution_snapshot_hash,
      recordExecutionSnapshotHash: record.execution_snapshot_hash ?? "",
      acceptedResumeExecutionSnapshotHash: job.execution_snapshot_hash,
      sourceCatalogFingerprint: sourceJob.catalog_fingerprint,
      recordCatalogFingerprint: record.catalog_fingerprint,
      currentCatalogFingerprint: createNativeStudioCapabilityCatalog(this.#platform).technical_fingerprint
    });
  }

  private async convergeCatalogDrift(job: StudioRunResumeRecord): Promise<void> {
    await this.cancelRunBeforeResume(job, studioRunResumeCatalogChanged());
    if (!await this.resumeStillNeedsRecovery(job)) {
      await this.cancelInterruptClaim(job);
      await this.completeResumeJob(job);
    }
  }

  private async cancelClaimedRunningResume(
    job: StudioRunResumeRecord,
    lease: NativeStudioRunLease,
    cause: unknown
  ): Promise<void> {
    await lease.commitTerminal(
      { status: "cancelled", cause },
      { completeness: "partial" },
      async (preparation) => {
        await this.#finalizer.commitDurableIntent(createNativeStudioRunTerminalIntent({
          runId: preparation.projectedRecord.run_id,
          command: preparation.command
        }));
      }
    );
    await this.cancelInterruptClaim(job);
    await this.completeResumeJob(job);
  }

  private async markClaimedRunningResumeUnknown(
    job: StudioRunResumeRecord,
    lease: NativeStudioRunLease,
    code: string,
    message: string
  ): Promise<void> {
    await lease.markOutcomeUnknown({ code, message });
    await this.cancelInterruptClaim(job);
    await this.completeResumeJob(job);
  }

  private async cancelRunBeforeResume(
    job: StudioRunResumeRecord,
    cause: unknown
  ): Promise<void> {
    // A terminal outbox may already be durable from an earlier process that
    // crashed before projecting it. Replay it before constructing another
    // intent so recovery never races two terminal revisions.
    await this.#finalizer.recover(job.run_id);
    const current = await this.#ledger.get(job.run_id);
    if (
      current === undefined ||
      (current.run_status !== undefined &&
        RunTerminalStatusSchema.safeParse(current.run_status).success)
    ) {
      return;
    }
    if (
      current.run_status !== "waiting_for_input" &&
      current.run_status !== "resuming"
    ) {
      throw runStoreError(
        "run_transition_invalid",
        "The accepted interrupt decision cannot be cancelled from the current run state"
      );
    }
    const lease = this.lease(job);
    await lease.commitTerminal(
      { status: "cancelled", cause },
      { completeness: "partial" },
      async (preparation) => {
        await this.#finalizer.commitDurableIntent(createNativeStudioRunTerminalIntent({
          runId: preparation.projectedRecord.run_id,
          command: preparation.command
        }));
      }
    );
  }

  private async resumeStillNeedsRecovery(job: StudioRunResumeRecord): Promise<boolean> {
    const record = await this.#ledger.get(job.run_id);
    return record !== undefined &&
      (record.run_status === "waiting_for_input" || record.run_status === "resuming");
  }

  private async cancelInterruptClaim(job: StudioRunResumeRecord): Promise<void> {
    let interrupt = await this.#interrupts.get(job.interrupt_id);
    if (interrupt === undefined || interrupt.status === "cancelled") return;
    if (interrupt.status === "resolved") {
      if (
        interrupt.resume === undefined ||
        stableJson(interrupt.resume.decision) !== stableJson(job.decision)
      ) {
        throw runStoreError(
          "run_store_corrupt",
          "A terminal run has a conflicting interrupt resume decision"
        );
      }
      return;
    }
    if (interrupt.status === "pending") {
      await this.claimInterrupt(job);
      interrupt = await this.#interrupts.get(job.interrupt_id);
    }
    if (
      interrupt?.status !== "resuming" ||
      interrupt.resume_attempt !== job.resume_id
    ) {
      throw runStoreError(
        "run_store_corrupt",
        "A terminal run has an incompatible interrupt resume claim"
      );
    }
    const claim: InterruptResumeClaim = {
      interrupt_id: job.interrupt_id,
      resume_attempt: job.resume_id,
      status: "claimed"
    };
    try {
      await this.#interrupts.completeResume(
        job.interrupt_id,
        claim,
        "cancelled"
      );
    } catch (cause) {
      const completed = await this.#interrupts.get(job.interrupt_id);
      if (
        completed?.status === "cancelled" &&
        completed.resume_attempt === job.resume_id
      ) {
        return;
      }
      throw cause;
    }
  }

  private lease(
    job: StudioRunResumeRecord,
    onHeartbeatError?: (cause: unknown) => void,
    ownerId = job.owner_id
  ): NativeStudioRunLease {
    return new NativeStudioRunLease({
      ledger: this.#ledger,
      runId: job.run_id,
      ownerId,
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

  private async completeResumeJob(job: StudioRunResumeRecord): Promise<void> {
    await this.#resumes.complete({
      resume_id: job.resume_id,
      command_hash: job.command_hash
    });
  }

  private async readResumeSourceOrConverge(
    job: StudioRunResumeRecord,
    record: RunRecord
  ): Promise<Awaited<ReturnType<NativeStudioRunDispatchQueue["read"]>> | undefined> {
    try {
      return await this.#queue.read(job.run_id);
    } catch (cause) {
      if (!isNativeStudioRunDispatchQueueCorruption(cause)) throw cause;
      await this.convergeMissingResumeDependency(job, record, "source_job");
      return undefined;
    }
  }

  private async convergeMissingResumeDependency(
    job: StudioRunResumeRecord,
    record: RunRecord,
    dependency: "interrupt" | "source_job"
  ): Promise<void> {
    if (
      record.run_status !== undefined &&
      RunTerminalStatusSchema.safeParse(record.run_status).success
    ) {
      await this.cancelInterruptClaim(job);
      await this.completeResumeJob(job);
      return;
    }

    const cause = runStoreError(
      "run_store_corrupt",
      dependency === "interrupt"
        ? "The accepted resume interrupt is unavailable"
        : "The accepted resume source job is unavailable"
    );
    const safeToCancel = job.stage.kind === "pre_execution" &&
      (record.run_status === "waiting_for_input" ||
        record.run_status === "resuming");
    if (safeToCancel) {
      await this.cancelRunBeforeResume(job, cause);
    } else {
      const lease = this.lease(
        job,
        undefined,
        record.owner_id ?? job.owner_id
      );
      await lease.markOutcomeUnknown({
        code: dependency === "interrupt"
          ? "studio_runtime_resume_interrupt_missing"
          : "studio_runtime_resume_source_invalid",
        message: dependency === "interrupt"
          ? "A resumed run lost its durable interrupt identity"
          : "A resumed run lost its immutable source material"
      });
    }
    await this.cancelInterruptClaim(job);
    await this.completeResumeJob(job);
  }

  private async pendingInterruptAfterResume(
    job: StudioRunResumeRecord
  ): Promise<DurablePendingInterrupt | undefined> {
    const interrupt = await this.#interrupts.findFirst(job.run_id, {
      exclude_id: job.interrupt_id,
      thread_id: job.thread_id,
      statuses: ["pending"]
    });
    if (interrupt === undefined) return undefined;
    if (
      interrupt.thread_id !== job.thread_id ||
      interrupt.checkpoint_id === undefined
    ) {
      throw runStoreError(
        "run_store_corrupt",
        "Pending interrupt is missing its durable waiting identity"
      );
    }
    return {
      ...interrupt,
      thread_id: interrupt.thread_id,
      checkpoint_id: interrupt.checkpoint_id
    };
  }

}
