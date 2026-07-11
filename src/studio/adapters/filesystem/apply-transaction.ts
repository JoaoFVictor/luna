import { studioApplyBytesDigest, studioApplyValueDigest } from "../../application/apply/digests.js";
import {
  StudioApplyError,
  StudioApplySimulatedCrash
} from "../../application/apply/errors.js";
import type {
  StudioApplyAttempt,
  StudioApplyJournalState,
  StudioApplyRecoveryResult,
  StudioApplyTransactionInput,
  StudioApplyTransactionPort,
  StudioApplyVerificationContext,
  StudioInstalledApplyVerificationPort
} from "../../application/apply/ports.js";
import { StudioApplyResultSchema, type StudioApplyResult } from "../../contracts/apply.js";
import { StudioDigestSchema } from "../../contracts/digests.js";
import { studioPathKey, studioResourceKey } from "../../contracts/paths.js";
import {
  FileSystemStudioApplyJournal,
  type StudioApplyJournal
} from "./apply-journal.js";
import {
  StudioApplyWorkspace,
  type StudioApplyWorkspaceFault
} from "./apply-workspace.js";

export type StudioApplyFaultStage =
  | "after_prepared"
  | "after_staging"
  | "after_backup_entry"
  | "after_backed_up"
  | "after_installing"
  | "after_install_entry"
  | "after_verifying"
  | "after_committed"
  | "after_rolling_back"
  | "after_rolled_back"
  | "after_recovery_required";

export type StudioApplyFaultInjector = (
  stage: StudioApplyFaultStage,
  context: { readonly operationId: string }
) => Promise<void> | void;

export type FileSystemStudioApplyTransactionOptions = {
  readonly journal: FileSystemStudioApplyJournal;
  readonly workspace: StudioApplyWorkspace;
  readonly now?: () => number;
  readonly maxEntries?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly faultInjector?: StudioApplyFaultInjector;
};

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

function positiveSafe(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StudioApplyError(
      "studio_apply_config_invalid",
      `${label} must be a positive safe integer`
    );
  }
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return studioApplyValueDigest(left) === studioApplyValueDigest(right);
}

function verificationContext(
  journal: StudioApplyJournal
): StudioApplyVerificationContext {
  return {
    resources: journal.verification.resources,
    expectedResourceRevisions:
      journal.verification.expected_resource_revisions,
    technicalCatalogFingerprint:
      journal.verification.technical_catalog_fingerprint,
    compilerContractVersion:
      journal.verification.compiler_contract_version
  };
}

export class FileSystemStudioApplyTransaction
  implements StudioApplyTransactionPort
{
  private readonly journal: FileSystemStudioApplyJournal;
  private readonly workspace: StudioApplyWorkspace;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly faultInjector: StudioApplyFaultInjector | undefined;

  constructor(options: FileSystemStudioApplyTransactionOptions) {
    this.journal = options.journal;
    this.workspace = options.workspace;
    this.now = options.now ?? Date.now;
    this.maxEntries = positiveSafe(
      options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      "Apply transaction entry limit"
    );
    this.maxFileBytes = positiveSafe(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      "Apply transaction file byte limit"
    );
    this.maxTotalBytes = positiveSafe(
      options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      "Apply transaction total byte limit"
    );
    this.faultInjector = options.faultInjector;
  }

  async findByIdempotencyKeyHash(
    idempotencyKeyHash: string
  ): Promise<StudioApplyAttempt | undefined> {
    if (!StudioDigestSchema.safeParse(idempotencyKeyHash).success) {
      throw new StudioApplyError(
        "studio_apply_journal_invalid",
        "Apply idempotency digest is invalid"
      );
    }
    return await this.journal.findByIdempotencyKeyHash(idempotencyKeyHash);
  }

  async execute(
    input: StudioApplyTransactionInput,
    verifier: StudioInstalledApplyVerificationPort
  ): Promise<StudioApplyResult> {
    this.assertInput(input);
    await this.workspace.assertNoPhysicalAliases([
      ...input.entries.map((entry) => entry.file),
      ...input.guards.map((guard) => guard.file)
    ]);
    await this.assertNoPendingRecovery();
    let current = await this.journal.create(input);
    try {
      await this.inject("after_prepared", current);
      await this.workspace.prepare(
        current,
        input.entries,
        async (createdDirectories) => {
          current = await this.journal.update(current, { createdDirectories });
        }
      );
      current = await this.journal.update(current, {
        stagingComplete: true
      });
      await this.inject("after_staging", current);

      await this.workspace.backUp(current);
      current = await this.transition(current, "backed_up", "after_backed_up");
      current = await this.transition(current, "installing", "after_installing");
      await this.workspace.install(current);
      current = await this.transition(current, "verifying", "after_verifying");
      await this.workspace.verifyInstalled(current);
      const resourceRevisions = await verifier.verify(
        verificationContext(current)
      );
      this.assertVerifiedRevisions(current, resourceRevisions);
      const result = this.result(current, resourceRevisions);
      current = await this.journal.update(current, {
        state: "committed",
        result
      });
      await this.inject("after_committed", current);
      await this.cleanUpBestEffort(current);
      return result;
    } catch (cause) {
      if (cause instanceof StudioApplySimulatedCrash) {
        throw new StudioApplyError(
          "studio_apply_recovery_required",
          "Studio apply was interrupted and requires startup recovery",
          {
            cause,
            details: {
              operationId: current.operation_id,
              state: current.state
            }
          }
        );
      }

      const durable = (await this.journal.get(current.operation_id)) ?? current;
      if (durable.state === "committed" && durable.result !== undefined) {
        await this.cleanUpBestEffort(durable);
        return durable.result;
      }
      try {
        await this.rollBack(durable);
      } catch (rollbackCause) {
        await this.markRecoveryRequired(durable, rollbackCause);
        throw new StudioApplyError(
          "studio_apply_recovery_required",
          "Studio apply failed and could not be safely rolled back",
          {
            cause: { operation: cause, rollback: rollbackCause },
            details: {
              operationId: durable.operation_id,
              state: durable.state
            }
          }
        );
      }
      throw new StudioApplyError(
        "studio_apply_rolled_back",
        "Studio apply failed and was rolled back",
        {
          cause,
          details: { operationId: durable.operation_id, state: durable.state }
        }
      );
    }
  }

  async recover(
    verifier: StudioInstalledApplyVerificationPort
  ): Promise<StudioApplyRecoveryResult> {
    const recovered: string[] = [];
    const committed: string[] = [];
    const recoveryRequired: string[] = [];
    for (const initial of await this.journal.list()) {
      let current = initial;
      try {
        if (current.state === "committed") {
          committed.push(current.operation_id);
          await this.cleanUpBestEffort(current);
          continue;
        }
        if (current.state === "rolled_back") {
          recovered.push(current.operation_id);
          await this.cleanUpBestEffort(current);
          continue;
        }

        const mayFinish =
          current.state === "installing" ||
          current.state === "verifying";
        if (mayFinish && (await this.workspace.isFullyInstalled(current))) {
          if (current.state !== "verifying") {
            current = await this.transition(
              current,
              "verifying",
              "after_verifying"
            );
          }
          await this.workspace.verifyInstalled(current);
          const resourceRevisions = await verifier.verify(
            verificationContext(current)
          );
          this.assertVerifiedRevisions(current, resourceRevisions);
          const result = this.result(current, resourceRevisions);
          current = await this.journal.update(current, {
            state: "committed",
            result
          });
          await this.inject("after_committed", current);
          committed.push(current.operation_id);
          await this.cleanUpBestEffort(current);
          continue;
        }

        current = await this.rollBack(current);
        recovered.push(current.operation_id);
      } catch (cause) {
        try {
          current = await this.markRecoveryRequired(current, cause);
        } catch {
          // The existing durable state remains authoritative.
        }
        recoveryRequired.push(current.operation_id);
      }
    }
    return { recovered, committed, recoveryRequired };
  }

  private assertInput(input: StudioApplyTransactionInput): void {
    if (
      input.entries.length < 1 ||
      input.entries.length > this.maxEntries ||
      input.allowedFiles.length > this.maxEntries ||
      input.guards.length > this.maxEntries ||
      input.diff.length > this.maxEntries ||
      input.verification.resources.length > this.maxEntries ||
      Object.keys(input.verification.expectedResourceRevisions).length >
        this.maxEntries
    ) {
      throw new StudioApplyError(
        "studio_apply_source_too_large",
        "Apply transaction collection size is outside its configured bounds"
      );
    }
    for (const digest of [
      input.draftHash,
      input.requestHash,
      input.idempotencyKeyHash,
      input.planTokenHash,
      input.planDigest,
      input.verification.technicalCatalogFingerprint
    ]) {
      if (!StudioDigestSchema.safeParse(digest).success) {
        throw new StudioApplyError(
          "studio_apply_journal_invalid",
          "Apply transaction contains an invalid digest"
        );
      }
    }
    const allowed = new Set(input.allowedFiles.map(studioPathKey));
    if (allowed.size !== input.allowedFiles.length) {
      throw new StudioApplyError(
        "studio_apply_path_invalid",
        "Apply allowlist contains duplicate paths"
      );
    }
    const entries = new Map<string, StudioApplyTransactionInput["entries"][number]>();
    let totalBytes = 0;
    for (const entry of input.entries) {
      const key = studioPathKey(entry.file);
      const [topLevel] = entry.file.path.split("/");
      if (topLevel === ".luna" || topLevel === ".git") {
        throw new StudioApplyError(
          "studio_apply_path_invalid",
          "Apply targets cannot modify Luna state or Git control storage",
          { details: { file: entry.file } }
        );
      }
      if (!allowed.has(key) || entries.has(key)) {
        throw new StudioApplyError(
          "studio_apply_path_invalid",
          "Apply transaction contains a duplicate or unauthorized target",
          { details: { file: entry.file } }
        );
      }
      entries.set(key, entry);
      if (
        (entry.beforeSha256 === null) !== (entry.beforeMode === null)
      ) {
        throw new StudioApplyError(
          "studio_apply_source_invalid",
          "Apply entry base hash and mode must both be present or absent",
          { details: { file: entry.file } }
        );
      }
      if (entry.action === "write") {
        if (
          entry.content === undefined ||
          entry.afterSha256 === null ||
          entry.mode === undefined ||
          studioApplyBytesDigest(entry.content) !== entry.afterSha256
        ) {
          throw new StudioApplyError(
            "studio_apply_source_invalid",
            "Apply write entry does not match its content hash or mode",
            { details: { file: entry.file } }
          );
        }
        totalBytes += entry.content.byteLength;
        if (
          entry.content.byteLength > this.maxFileBytes ||
          totalBytes > this.maxTotalBytes
        ) {
          throw new StudioApplyError(
            "studio_apply_source_too_large",
            "Apply transaction content exceeds its configured byte limit",
            { details: { file: entry.file } }
          );
        }
      } else if (
        entry.content !== undefined ||
        entry.mode !== undefined ||
        entry.afterSha256 !== null ||
        entry.beforeSha256 === null
      ) {
        throw new StudioApplyError(
          "studio_apply_source_invalid",
          "Apply delete entry has an invalid shape",
          { details: { file: entry.file } }
        );
      }
    }

    const guards = new Map(input.guards.map((guard) => [studioPathKey(guard.file), guard]));
    if (guards.size !== input.guards.length) {
      throw new StudioApplyError(
        "studio_apply_source_invalid",
        "Apply read set contains duplicate paths"
      );
    }
    for (const guard of input.guards) {
      if (
        guard.mode !== undefined &&
        (guard.sha256 === null) !== (guard.mode === null)
      ) {
        throw new StudioApplyError(
          "studio_apply_source_invalid",
          "Apply read-set hash and mode must both be present or absent",
          { details: { file: guard.file } }
        );
      }
    }
    for (const [key, entry] of entries) {
      const guard = guards.get(key);
      if (
        guard?.sha256 !== entry.beforeSha256 ||
        guard.mode !== entry.beforeMode
      ) {
        throw new StudioApplyError(
          "studio_apply_source_invalid",
          "Every apply target hash and mode must be pinned in the transaction read set",
          { details: { file: entry.file } }
        );
      }
    }

    const diffs = new Map(input.diff.map((diff) => [studioPathKey(diff.file), diff]));
    if (diffs.size !== input.diff.length || diffs.size !== entries.size) {
      throw new StudioApplyError(
        "studio_apply_plan_invalid",
        "Apply structured diff does not match its transaction entries"
      );
    }
    for (const [key, entry] of entries) {
      const diff = diffs.get(key);
      if (
        diff === undefined ||
        diff.before_sha256 !== entry.beforeSha256 ||
        diff.before_mode !== entry.beforeMode ||
        diff.after_sha256 !== entry.afterSha256 ||
        diff.after_mode !== (entry.mode ?? null)
      ) {
        throw new StudioApplyError(
          "studio_apply_plan_invalid",
          "Apply structured diff hashes differ from its transaction"
        );
      }
    }

    const expectedResources = new Set(
      input.verification.resources.map(studioResourceKey)
    );
    if (
      expectedResources.size !== input.verification.resources.length ||
      !sameValue(
        [...expectedResources].sort(),
        Object.keys(input.verification.expectedResourceRevisions).sort()
      )
    ) {
      throw new StudioApplyError(
        "studio_apply_validation_failed",
        "Apply verification revisions do not exactly match its resources"
      );
    }
  }

  private async assertNoPendingRecovery(): Promise<void> {
    const pending = (await this.journal.list()).find(
      (journal) =>
        journal.state !== "committed" && journal.state !== "rolled_back"
    );
    if (pending !== undefined) {
      throw new StudioApplyError(
        "studio_apply_recovery_required",
        "A previous Studio apply must be recovered before starting another transaction",
        {
          details: {
            operationId: pending.operation_id,
            state: pending.state
          }
        }
      );
    }
  }

  private result(
    journal: StudioApplyJournal,
    resourceRevisions: Readonly<Record<string, string>>
  ): StudioApplyResult {
    return StudioApplyResultSchema.parse({
      status: "committed",
      operation_id: journal.operation_id,
      draft_id: journal.draft_id,
      record_revision: journal.record_revision,
      draft_hash: journal.draft_hash,
      resource_revisions: resourceRevisions,
      files: journal.entries.map((entry) => ({
        file: entry.file,
        sha256: entry.after_sha256
      })),
      diff: journal.diff,
      committed_at: this.timestamp(),
      idempotent_replay: false
    });
  }

  private assertVerifiedRevisions(
    journal: StudioApplyJournal,
    actual: Readonly<Record<string, string>>
  ): void {
    if (
      !sameValue(
        actual,
        journal.verification.expected_resource_revisions
      )
    ) {
      throw new StudioApplyError(
        "studio_apply_validation_failed",
        "Installed resource revisions differ from the apply journal",
        { details: { operationId: journal.operation_id } }
      );
    }
  }

  private async transition(
    current: StudioApplyJournal,
    state: StudioApplyJournalState,
    faultStage: StudioApplyFaultStage
  ): Promise<StudioApplyJournal> {
    const next = await this.journal.update(current, { state });
    await this.inject(faultStage, next);
    return next;
  }

  private async rollBack(
    current: StudioApplyJournal
  ): Promise<StudioApplyJournal> {
    if (current.state === "rolled_back") {
      return current;
    }
    let rolling = current;
    if (rolling.state !== "rolling_back") {
      rolling = await this.transition(
        rolling,
        "rolling_back",
        "after_rolling_back"
      );
    }
    await this.workspace.rollBack(rolling);
    const rolled = await this.transition(
      rolling,
      "rolled_back",
      "after_rolled_back"
    );
    await this.cleanUpBestEffort(rolled);
    return rolled;
  }

  private async markRecoveryRequired(
    current: StudioApplyJournal,
    cause: unknown
  ): Promise<StudioApplyJournal> {
    const durable = (await this.journal.get(current.operation_id)) ?? current;
    if (durable.state === "committed" || durable.state === "rolled_back") {
      return durable;
    }
    const marked = await this.journal.update(durable, {
      state: "recovery_required"
    });
    try {
      await this.inject("after_recovery_required", marked);
    } catch (faultCause) {
      throw new StudioApplyError(
        "studio_apply_recovery_required",
        "Apply recovery marker is durable but recovery was interrupted",
        { cause: { original: cause, fault: faultCause } }
      );
    }
    return marked;
  }

  private async inject(
    stage: StudioApplyFaultStage,
    journal: StudioApplyJournal
  ): Promise<void> {
    await this.faultInjector?.(stage, {
      operationId: journal.operation_id
    });
  }

  private async cleanUpBestEffort(journal: StudioApplyJournal): Promise<void> {
    try {
      await this.workspace.cleanUp(journal);
    } catch {
      // Terminal journal state is durable; startup recovery retries cleanup.
    }
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Apply transaction clock must return a non-negative safe integer"
      );
    }
    return new Date(value).toISOString();
  }
}

export function createStudioApplyWorkspaceFaultAdapter(
  injector: StudioApplyFaultInjector | undefined
): StudioApplyWorkspaceFault | undefined {
  if (injector === undefined) {
    return undefined;
  }
  return async (stage, context) => {
    await injector(stage, { operationId: context.operationId });
  };
}
