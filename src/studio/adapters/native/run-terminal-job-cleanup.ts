import type { RunLedgerPort } from "../../application/runs/ports.js";
import {
  RunTerminalStatusSchema,
  type RunRecord
} from "../../contracts/runs.js";
import type { NativeStudioRunDispatchQueue } from "../filesystem/run-dispatch-queue.js";
import type { NativeStudioRunFinalizer } from "./run-finalizer.js";

export type NativeStudioRunBackgroundDiagnostic = (
  code: "dispatch_terminal_cleanup_failed" | "dispatch_recovery_failed",
  runId: string | undefined,
  cause: unknown
) => void;

export function isNativeStudioTerminalRecord(record: RunRecord): boolean {
  return record.dispatch_status === "rejected" ||
    (record.run_status !== undefined &&
      RunTerminalStatusSchema.safeParse(record.run_status).success);
}

/**
 * Owns the proof barrier between a terminal ledger record and deletion of the
 * immutable dispatch material. Callers never need to reproduce these rules.
 */
export class NativeStudioRunTerminalJobCleanup {
  readonly #ledger: RunLedgerPort;
  readonly #queue: NativeStudioRunDispatchQueue;
  readonly #finalizer: NativeStudioRunFinalizer;
  readonly #reportDiagnostic: NativeStudioRunBackgroundDiagnostic;

  constructor(options: {
    readonly ledger: RunLedgerPort;
    readonly queue: NativeStudioRunDispatchQueue;
    readonly finalizer: NativeStudioRunFinalizer;
    readonly reportDiagnostic: NativeStudioRunBackgroundDiagnostic;
  }) {
    this.#ledger = options.ledger;
    this.#queue = options.queue;
    this.#finalizer = options.finalizer;
    this.#reportDiagnostic = options.reportDiagnostic;
  }

  async removeIfSafe(runId: string): Promise<void> {
    try {
      const record = await this.#ledger.get(runId);
      if (record === undefined || !isNativeStudioTerminalRecord(record)) {
        return;
      }
      if (record.run_status === "outcome_unknown") {
        // The ledger CAS transition is the terminal authority for an uncertain
        // external outcome. It deliberately has no success/failure graph proof
        // journal, but its immutable terminal is enough to discard sensitive
        // dispatch inputs and definition snapshots.
        await this.#queue.removeTerminalJob(runId);
        return;
      }
      // Runtime terminals may only delete the job that owns their recovery
      // journal after replay proves that exact intent against the ledger.
      // A rejected dispatch has no runtime terminal intent to recover.
      if (
        record.dispatch_status !== "rejected" &&
        !await this.#finalizer.recover(runId)
      ) {
        return;
      }
      await this.#queue.removeTerminalJob(runId);
    } catch (cause) {
      this.#reportDiagnostic(
        "dispatch_terminal_cleanup_failed",
        runId,
        cause
      );
    }
  }
}
