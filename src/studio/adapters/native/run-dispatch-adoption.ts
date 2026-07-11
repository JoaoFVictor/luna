import { studioRunValueDigest } from "../../application/runs/launch-digests.js";
import { studioRunLaunchError } from "../../application/runs/launch-errors.js";
import type {
  StudioRunDispatchCommand
} from "../../application/runs/launch-ports.js";
import type { RunLedgerPort } from "../../application/runs/ports.js";
import type { StudioRunDispatchReceipt } from "../../contracts/run-launch.js";
import { RunTerminalStatusSchema } from "../../contracts/runs.js";
import type { NativeStudioRunDispatchQueue } from "../filesystem/run-dispatch-queue.js";
import type { NativeStudioRunDispatchPayload } from "./run-snapshot-contracts.js";
import {
  isNativeStudioTerminalRecord,
  type NativeStudioRunBackgroundDiagnostic,
  type NativeStudioRunTerminalJobCleanup
} from "./run-terminal-job-cleanup.js";

type NativeStudioDispatchIdentity = {
  readonly runId: string;
  readonly bindingHash: string;
};

/**
 * Resolves exact idempotency retries against terminal ledger authority. The
 * dispatcher delegates all terminal-shape and provenance matching here.
 */
export class NativeStudioRunDispatchAdoption {
  readonly #ledger: RunLedgerPort;
  readonly #queue: NativeStudioRunDispatchQueue;
  readonly #cleanup: NativeStudioRunTerminalJobCleanup;
  readonly #reportDiagnostic: NativeStudioRunBackgroundDiagnostic;

  constructor(options: {
    readonly ledger: RunLedgerPort;
    readonly queue: NativeStudioRunDispatchQueue;
    readonly cleanup: NativeStudioRunTerminalJobCleanup;
    readonly reportDiagnostic: NativeStudioRunBackgroundDiagnostic;
  }) {
    this.#ledger = options.ledger;
    this.#queue = options.queue;
    this.#cleanup = options.cleanup;
    this.#reportDiagnostic = options.reportDiagnostic;
  }

  async resolve(
    command: StudioRunDispatchCommand<NativeStudioRunDispatchPayload>,
    identity: NativeStudioDispatchIdentity,
    queuedRetry?: {
      readonly runId: string;
      readonly createdByRetry: boolean;
    }
  ): Promise<StudioRunDispatchReceipt | undefined> {
    const record = await this.#ledger.get(identity.runId);
    if (record === undefined || !isNativeStudioTerminalRecord(record)) {
      return undefined;
    }
    if (
      record.run_id !== identity.runId ||
      record.workflow_id !== command.request.workflow_id ||
      record.execution_snapshot_hash !==
        command.snapshot.execution_snapshot_hash ||
      record.workflow_revision !== command.snapshot.workflow_revision ||
      record.definition_bundle_hash !== command.snapshot.definition_bundle_hash ||
      record.catalog_fingerprint !== command.snapshot.catalog_fingerprint ||
      record.repository_id !== command.snapshot.repository_id ||
      studioRunValueDigest(record.input_provenance) !==
        studioRunValueDigest(command.request.input_provenance)
    ) {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        "Existing terminal run does not match this idempotency binding",
        {
          run_id: identity.runId,
          idempotency_binding_hash: identity.bindingHash
        }
      );
    }
    if (queuedRetry !== undefined) {
      await this.cleanupQueuedRetry(
        queuedRetry.runId,
        queuedRetry.createdByRetry
      );
    }
    if (record.dispatch_status === "rejected") {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        "The original idempotent native run was rejected",
        {
          run_id: record.run_id,
          terminal_failure_code:
            record.failure?.code ?? "studio_run_dispatch_failed"
        }
      );
    }
    if (
      record.dispatch_status !== "started" ||
      record.run_status === undefined ||
      !RunTerminalStatusSchema.safeParse(record.run_status).success
    ) {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        "Existing idempotency record has an invalid terminal shape",
        { run_id: identity.runId }
      );
    }
    return {
      accepted: true,
      dispatch_status: "queued",
      run_id: record.run_id,
      plan_id: command.planId,
      execution_snapshot_hash: command.snapshot.execution_snapshot_hash,
      accepted_at: record.created_at
    };
  }

  private async cleanupQueuedRetry(
    runId: string,
    createdByRetry: boolean
  ): Promise<void> {
    if (!createdByRetry) {
      await this.#cleanup.removeIfSafe(runId);
      return;
    }
    try {
      await this.#queue.removeTerminalJob(runId);
    } catch (cause) {
      this.#reportDiagnostic("dispatch_terminal_cleanup_failed", runId, cause);
    }
  }
}
