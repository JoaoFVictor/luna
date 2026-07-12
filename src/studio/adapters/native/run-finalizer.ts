import {
  runGraphOutcomeMatchesProof,
  runGraphSnapshotIdentitiesEqual,
  type RunGraphOutcomeProof,
  type RunGraphSnapshotStorePort,
  type StoredRunGraphOutcome
} from "../../application/runs/graph-snapshot.js";
import type { RunLedgerPort } from "../../application/runs/ports.js";
import {
  StudioRunLaunchError,
  studioRunLaunchError
} from "../../application/runs/launch-errors.js";
import type { RunRecord } from "../../contracts/runs.js";
import { canonicalJson } from "../../../core/workflow/definition-digests.js";
import {
  isNativeStudioRunTerminalJournalCorruption,
  type NativeStudioRunTerminalJournalPort
} from "../filesystem/run-terminal-journal.js";
import {
  NativeStudioRunTerminalIntentSchema,
  type NativeStudioRunTerminalIntent
} from "./run-terminal-intent.js";

function finalizationError(message: string, cause?: unknown): Error {
  return studioRunLaunchError(
    "studio_run_dispatch_failed",
    message,
    {},
    cause === undefined ? undefined : { cause }
  );
}

function finalizationIntegrityError(message: string, cause?: unknown): Error {
  return studioRunLaunchError(
    "studio_run_dispatch_failed",
    message,
    { terminal_recovery_corruption: true },
    cause === undefined ? undefined : { cause }
  );
}

type NativeStudioTerminalIntentLedgerState =
  | "pending"
  | "applied"
  | "conflict";

function isRevisionConflict(cause: unknown): boolean {
  return (cause as { readonly code?: unknown })?.code ===
    "run_revision_conflict";
}

export function isNativeStudioRunFinalizationIntegrityFailure(
  cause: unknown
): boolean {
  return cause instanceof StudioRunLaunchError &&
    cause.details.terminal_recovery_corruption === true;
}

export class NativeStudioRunFinalizer {
  readonly #ledger: RunLedgerPort;
  readonly #graphStore: RunGraphSnapshotStorePort;
  readonly #journal: NativeStudioRunTerminalJournalPort;

  constructor(options: {
    readonly ledger: RunLedgerPort;
    readonly graphStore: RunGraphSnapshotStorePort;
    readonly journal: NativeStudioRunTerminalJournalPort;
  }) {
    this.#ledger = options.ledger;
    this.#graphStore = options.graphStore;
    this.#journal = options.journal;
  }

  async commit(input: NativeStudioRunTerminalIntent): Promise<void> {
    const intent = NativeStudioRunTerminalIntentSchema.parse(input);
    await this.#journal.write(intent);
    await this.replay(intent);
  }

  /**
   * Persist a terminal intent as the cleanup barrier. If replay reports an
   * acceptance-unknown failure after the exact journal became durable, the
   * journal remains authoritative and normal recovery will finish replay.
   */
  async commitDurableIntent(input: NativeStudioRunTerminalIntent): Promise<void> {
    const intent = NativeStudioRunTerminalIntentSchema.parse(input);
    try {
      await this.commit(intent);
    } catch (cause) {
      if (isNativeStudioRunFinalizationIntegrityFailure(cause)) {
        throw cause;
      }
      const ledgerState = await this.intentLedgerState(intent);
      if (ledgerState === "applied") {
        await this.assertAppliedOutcome(intent);
        return;
      }
      if (ledgerState === "conflict" || isRevisionConflict(cause)) {
        throw finalizationIntegrityError(
          "Native run terminal intent conflicts with the ledger revision",
          cause
        );
      }
      await this.assertExactIntentDurable(intent, cause);
      try {
        await this.replay(intent);
      } catch (replayCause) {
        if (isNativeStudioRunFinalizationIntegrityFailure(replayCause)) {
          throw replayCause;
        }
        if (isRevisionConflict(replayCause)) {
          throw finalizationIntegrityError(
            "Native run terminal intent conflicts with the ledger revision",
            replayCause
          );
        }
        // The exact recovery intent is durable even if a transient failure
        // still prevents its ledger projection in this process.
      }
    }
  }

  async recover(runId: string): Promise<boolean> {
    let intent;
    try {
      intent = await this.#journal.read(runId);
    } catch (cause) {
      if (isNativeStudioRunTerminalJournalCorruption(cause)) {
        throw finalizationIntegrityError(
          "Native run terminal journal failed integrity validation",
          cause
        );
      }
      throw cause;
    }
    if (intent === undefined) {
      return false;
    }
    await this.replay(intent);
    return true;
  }

  private async replay(input: NativeStudioRunTerminalIntent): Promise<void> {
    const parsed = NativeStudioRunTerminalIntentSchema.safeParse(input);
    if (!parsed.success) {
      throw finalizationIntegrityError(
        "Native run terminal intent failed integrity validation"
      );
    }
    const intent = parsed.data;
    const transition = intent.command.transition;
    if (transition.kind !== "runtime_status") {
      throw finalizationIntegrityError(
        "Native run terminal intent has no runtime transition"
      );
    }
    const ledgerState = await this.intentLedgerState(intent);
    if (ledgerState === "applied") {
      await this.assertAppliedOutcome(intent);
      return;
    }
    if (ledgerState === "conflict") {
      throw finalizationIntegrityError(
        "Native run terminal intent conflicts with an existing ledger terminal"
      );
    }
    const outcome = intent.outcome;
    if (outcome !== undefined) {
      if (transition.outcome_proof === undefined) {
        throw finalizationIntegrityError(
          "Native run terminal outcome has no integrity proof"
        );
      }
      await this.ensureOutcome(outcome, transition.outcome_proof);
    }
    let mutation;
    try {
      mutation = await this.#ledger.appendTransition(intent.command);
    } catch (cause) {
      const ledgerState = await this.intentLedgerState(intent);
      if (ledgerState === "applied") {
        await this.assertAppliedOutcome(intent);
        return;
      }
      if (ledgerState === "conflict" || isRevisionConflict(cause)) {
        throw finalizationIntegrityError(
          "Native run terminal intent conflicts with an existing ledger terminal",
          cause
        );
      }
      throw cause;
    }
    const expectedRevision = intent.command.expected_revision + 1;
    if (
      mutation.transition_revision !== expectedRevision ||
      mutation.record.record_revision !== expectedRevision ||
      mutation.record.run_status !== transition.status ||
      mutation.record.completeness !== transition.completeness ||
      (transition.outcome_proof !== undefined &&
        !recordMatchesProof(mutation.record, transition.outcome_proof))
    ) {
      throw finalizationIntegrityError(
        "Native run terminal intent did not produce its exact ledger record"
      );
    }
  }

  private async assertExactIntentDurable(
    intent: NativeStudioRunTerminalIntent,
    originalCause: unknown
  ): Promise<void> {
    let existing: NativeStudioRunTerminalIntent | undefined;
    try {
      existing = await this.#journal.read(intent.run_id);
    } catch {
      throw originalCause;
    }
    if (
      existing === undefined ||
      canonicalJson(existing) !== canonicalJson(intent)
    ) {
      throw originalCause;
    }
  }

  private async intentLedgerState(
    intent: NativeStudioRunTerminalIntent
  ): Promise<NativeStudioTerminalIntentLedgerState> {
    const record = await this.#ledger.get(intent.run_id);
    if (record === undefined) {
      return "conflict";
    }
    if (recordMatchesIntent(record, intent)) {
      return "applied";
    }
    const expectedTerminalRevision =
      intent.command.expected_revision + 1;
    if (
      record.dispatch_status === "rejected" ||
      record.run_status === "succeeded" ||
      record.run_status === "failed" ||
      record.run_status === "outcome_unknown" ||
      record.run_status === "timed_out" ||
      record.run_status === "cancelled" ||
      record.record_revision >= expectedTerminalRevision
    ) {
      return "conflict";
    }
    return "pending";
  }

  private async assertAppliedOutcome(
    intent: NativeStudioRunTerminalIntent
  ): Promise<void> {
    const transition = intent.command.transition;
    if (transition.kind !== "runtime_status") {
      throw finalizationIntegrityError(
        "Native run terminal intent has no runtime transition"
      );
    }
    if (intent.outcome !== undefined) {
      if (transition.outcome_proof === undefined) {
        throw finalizationIntegrityError(
          "Native run terminal outcome has no integrity proof"
        );
      }
      await this.ensureOutcome(intent.outcome, transition.outcome_proof);
    }
  }

  private async ensureOutcome(
    outcome: StoredRunGraphOutcome,
    proof: RunGraphOutcomeProof
  ): Promise<void> {
    await this.assertStoredGraph(outcome);
    const handle = outcome.identity.graph_snapshot_handle;
    const existing = await this.#graphStore.readOutcome(handle);
    if (existing.kind === "available") {
      this.assertExactOutcome(existing.value, outcome, proof);
      return;
    }
    if (existing.kind === "corrupt") {
      throw finalizationIntegrityError(
        "Native run terminal outcome storage is corrupt"
      );
    }
    if (existing.kind === "unavailable") {
      throw finalizationError("Native run terminal outcome is unavailable");
    }

    try {
      await this.#graphStore.writeOutcome(outcome);
    } catch (cause) {
      // A failed exclusive write may still have raced with an equivalent
      // durable writer. Re-read both records before deciding whether the
      // failure is transient or deterministic corruption.
      await this.assertStoredGraph(outcome);
      const afterFailure = await this.#graphStore.readOutcome(handle);
      if (afterFailure.kind === "available") {
        this.assertExactOutcome(afterFailure.value, outcome, proof);
        return;
      }
      if (afterFailure.kind === "corrupt") {
        throw finalizationIntegrityError(
          "Native run terminal outcome became corrupt while persisting",
          cause
        );
      }
      throw cause;
    }

    const stored = await this.#graphStore.readOutcome(handle);
    if (stored.kind === "available") {
      this.assertExactOutcome(stored.value, outcome, proof);
      return;
    }
    if (stored.kind === "unavailable") {
      throw finalizationError(
        "Native run terminal outcome could not be verified after persistence"
      );
    }
    throw finalizationIntegrityError(
      "Native run terminal outcome disappeared or became corrupt after persistence"
    );
  }

  private async assertStoredGraph(
    outcome: StoredRunGraphOutcome
  ): Promise<void> {
    const graph = await this.#graphStore.readGraph(
      outcome.identity.graph_snapshot_handle
    );
    if (graph.kind === "unavailable") {
      throw finalizationError("Native run graph is temporarily unavailable");
    }
    if (graph.kind !== "available") {
      throw finalizationIntegrityError(
        "Native run terminal outcome references a missing or corrupt graph"
      );
    }
    if (
      graph.value.graph_hash !== outcome.graph_hash ||
      !runGraphSnapshotIdentitiesEqual(
        graph.value.identity,
        outcome.identity
      )
    ) {
      throw finalizationIntegrityError(
        "Native run terminal outcome does not match its durable graph"
      );
    }
    const graphNodeIds = new Set(
      graph.value.graph.nodes.map((node) => node.id)
    );
    if (outcome.nodes.some((node) => !graphNodeIds.has(node.node_id))) {
      throw finalizationIntegrityError(
        "Native run terminal outcome references an unknown durable graph node"
      );
    }
  }

  private assertExactOutcome(
    stored: StoredRunGraphOutcome,
    outcome: StoredRunGraphOutcome,
    proof: RunGraphOutcomeProof
  ): void {
    if (
      canonicalJson(stored) !== canonicalJson(outcome) ||
      !runGraphOutcomeMatchesProof(stored, proof)
    ) {
      throw finalizationIntegrityError(
        "Native run terminal outcome differs from its durable intent"
      );
    }
  }
}

function recordMatchesProof(
  record: RunRecord,
  proof: RunGraphOutcomeProof
): boolean {
  return record.graph_snapshot_handle === proof.identity.graph_snapshot_handle &&
    record.run_id === proof.identity.run_id &&
    record.workflow_id === proof.identity.workflow_id &&
    record.workflow_revision === proof.identity.workflow_revision &&
    record.definition_bundle_hash === proof.identity.definition_bundle_hash &&
    record.execution_snapshot_hash === proof.identity.execution_snapshot_hash &&
    record.record_revision === proof.record_revision &&
    record.run_status === proof.run_status;
}

function recordMatchesIntent(
  record: RunRecord,
  intent: NativeStudioRunTerminalIntent
): boolean {
  const transition = intent.command.transition;
  if (transition.kind !== "runtime_status") {
    return false;
  }
  const expectedRevision = intent.command.expected_revision + 1;
  const exactFailure = canonicalJson(record.failure ?? null) ===
    canonicalJson(transition.failure ?? null);
  return record.record_revision === expectedRevision &&
    record.dispatch_status === "started" &&
    record.owner_id === transition.owner_id &&
    record.run_status === transition.status &&
    record.completeness === (transition.completeness ?? "partial") &&
    record.finished_at === intent.command.occurred_at &&
    record.updated_at === intent.command.occurred_at &&
    record.heartbeat_at === intent.command.occurred_at &&
    record.failed_node_id === transition.failed_node_id &&
    exactFailure &&
    record.active_node_ids.length === transition.active_node_ids.length &&
    record.active_node_ids.every(
      (nodeId, index) => nodeId === transition.active_node_ids[index]
    ) &&
    (transition.artifact_count === undefined ||
      record.artifact_count === transition.artifact_count) &&
    (transition.interrupt_count === undefined ||
      record.interrupt_count === transition.interrupt_count) &&
    (transition.outcome_proof === undefined ||
      recordMatchesProof(record, transition.outcome_proof));
}
