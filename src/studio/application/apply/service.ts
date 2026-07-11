import { randomUUID } from "node:crypto";
import { LUNA_WORKFLOW_COMPILER_SCHEMA_VERSION } from "../../../core/workflow/definition-revision.js";
import type { StudioDraftValidationService } from "../validation/draft-validation.js";
import {
  assertStudioChangeSetIntegrity
} from "../drafts/change-set.js";
import {
  StudioDraftPersistenceError,
  type StudioDraftPersistencePort
} from "../drafts/persistence.js";
import {
  StudioApplyPlanResponseSchema,
  StudioApplyRequestSchema,
  StudioApplyResultSchema,
  type StudioApplyConflict,
  type StudioApplyFileDiff,
  type StudioApplyPlanResponse,
  type StudioApplyResult
} from "../../contracts/apply.js";
import type {
  StudioChangeSet,
  StudioDraftFileChange
} from "../../contracts/drafts.js";
import {
  studioPathKey,
  studioResourceKey,
  type StudioPath
} from "../../contracts/paths.js";
import { projectStudioApplyDiff } from "./diff.js";
import {
  studioApplyBytesDigest,
  studioApplySecretDigest,
  studioApplyValueDigest
} from "./digests.js";
import { StudioApplyError } from "./errors.js";
import type {
  StudioApplyGuard,
  StudioApplyLockPort,
  StudioApplyPlanBinding,
  StudioApplyPlanTokenPort,
  StudioApplySourceFile,
  StudioApplySourcePort,
  StudioApplyTransactionEntry,
  StudioApplyTransactionPort,
  StudioApplyVerificationContext,
  StudioInstalledApplyVerificationPort,
  StudioStoredApplyPlan
} from "./ports.js";

const DEFAULT_PLAN_TTL_MS = 2 * 60 * 1_000;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_DIFF_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_DIFF_TOTAL_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 512;
const CONTRACT_MAX_DIFF_FILE_BYTES = 256 * 1024;
const CONTRACT_MAX_DIFF_TOTAL_BYTES = 256 * 1024;
const CONTRACT_MAX_COMPILER_VERSION_BYTES = 256;

type ApplyLimits = {
  readonly planTtlMs: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxDiffFileBytes: number;
  readonly maxDiffTotalBytes: number;
  readonly maxFiles: number;
};

type AuthorityPlan = {
  readonly stored: StudioStoredApplyPlan;
  readonly diff: readonly StudioApplyFileDiff[];
  readonly conflicts: readonly StudioApplyConflict[];
  readonly entries: readonly StudioApplyTransactionEntry[];
  readonly guards: readonly StudioApplyGuard[];
};

export type StudioApplyServiceOptions = {
  readonly drafts: StudioDraftPersistencePort;
  readonly source: StudioApplySourcePort;
  readonly validation: Pick<StudioDraftValidationService, "validate">;
  readonly planTokens: StudioApplyPlanTokenPort;
  readonly transactions: StudioApplyTransactionPort;
  readonly lockManager: StudioApplyLockPort;
  readonly installedVerifier: StudioInstalledApplyVerificationPort;
  readonly technicalCatalogFingerprint: () => Promise<string> | string;
  readonly compilerContractVersion?: string;
  readonly lockResource?: string;
  readonly now?: () => number;
  readonly randomOperationId?: () => string;
  readonly limits?: Partial<ApplyLimits>;
};

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StudioApplyError(
      "studio_apply_config_invalid",
      `${label} must be a positive safe integer`
    );
  }
  return value;
}

function resolveLimits(input: Partial<ApplyLimits> = {}): ApplyLimits {
  const limits = {
    planTtlMs: input.planTtlMs ?? DEFAULT_PLAN_TTL_MS,
    maxFileBytes: input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: input.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxDiffFileBytes:
      input.maxDiffFileBytes ?? DEFAULT_MAX_DIFF_FILE_BYTES,
    maxDiffTotalBytes:
      input.maxDiffTotalBytes ?? DEFAULT_MAX_DIFF_TOTAL_BYTES,
    maxFiles: input.maxFiles ?? DEFAULT_MAX_FILES
  };
  positiveSafeInteger(limits.planTtlMs, "Apply plan TTL");
  positiveSafeInteger(limits.maxFileBytes, "Apply file byte limit");
  positiveSafeInteger(limits.maxTotalBytes, "Apply total byte limit");
  positiveSafeInteger(limits.maxDiffFileBytes, "Apply file diff byte limit");
  positiveSafeInteger(limits.maxDiffTotalBytes, "Apply total diff byte limit");
  positiveSafeInteger(limits.maxFiles, "Apply file count limit");
  if (limits.maxDiffFileBytes > CONTRACT_MAX_DIFF_FILE_BYTES) {
    throw new StudioApplyError(
      "studio_apply_config_invalid",
      `Apply file diff byte limit cannot exceed ${CONTRACT_MAX_DIFF_FILE_BYTES}`
    );
  }
  if (limits.maxDiffTotalBytes > CONTRACT_MAX_DIFF_TOTAL_BYTES) {
    throw new StudioApplyError(
      "studio_apply_config_invalid",
      `Apply total diff byte limit cannot exceed ${CONTRACT_MAX_DIFF_TOTAL_BYTES}`
    );
  }
  return limits;
}

function ordered<T>(
  values: readonly T[],
  key: (value: T) => string
): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

function expectedConflictKind(
  expected: string | null,
  actual: string | null
): StudioApplyConflict["kind"] {
  if (expected === null) {
    return "created";
  }
  if (actual === null) {
    return "deleted";
  }
  return "modified";
}

function draftEtag(changeSet: StudioChangeSet): string {
  return `"studio-draft:${changeSet.draft_id}:${changeSet.record_revision}:${changeSet.draft_hash}"`;
}

export function studioDraftApplyEtag(changeSet: StudioChangeSet): string {
  return draftEtag(changeSet);
}

class ReadBudget {
  private consumed = 0;

  constructor(private readonly limits: ApplyLimits) {}

  nextLimit(file: StudioPath): number {
    const remaining = this.limits.maxTotalBytes - this.consumed;
    if (remaining < 1) {
      throw new StudioApplyError(
        "studio_apply_source_too_large",
        "Studio apply source exceeds the aggregate byte limit",
        {
          details: {
            file,
            actualBytes: this.consumed,
            maxBytes: this.limits.maxTotalBytes
          }
        }
      );
    }
    return Math.min(this.limits.maxFileBytes, remaining);
  }

  account(file: StudioPath, bytes: number): void {
    this.consumed += bytes;
    if (
      bytes > this.limits.maxFileBytes ||
      this.consumed > this.limits.maxTotalBytes
    ) {
      throw new StudioApplyError(
        "studio_apply_source_too_large",
        "Studio apply source exceeds its configured byte limit",
        {
          details: {
            file,
            actualBytes: Math.max(bytes, this.consumed),
            maxBytes:
              bytes > this.limits.maxFileBytes
                ? this.limits.maxFileBytes
                : this.limits.maxTotalBytes
          }
        }
      );
    }
  }
}

function assertSameValue(
  actual: unknown,
  expected: unknown,
  code: "studio_apply_plan_stale" | "studio_apply_validation_failed",
  message: string
): void {
  if (studioApplyValueDigest(actual) !== studioApplyValueDigest(expected)) {
    throw new StudioApplyError(code, message);
  }
}

function resultWithReplay(result: StudioApplyResult): StudioApplyResult {
  return StudioApplyResultSchema.parse({
    ...result,
    idempotent_replay: true
  });
}

export class StudioApplyService {
  private readonly drafts: StudioDraftPersistencePort;
  private readonly source: StudioApplySourcePort;
  private readonly validation: Pick<StudioDraftValidationService, "validate">;
  private readonly planTokens: StudioApplyPlanTokenPort;
  private readonly transactions: StudioApplyTransactionPort;
  private readonly lockManager: StudioApplyLockPort;
  private readonly installedVerifier: StudioInstalledApplyVerificationPort;
  private readonly technicalCatalogFingerprint: () =>
    | Promise<string>
    | string;
  private readonly compilerContractVersion: string;
  private readonly lockResource: string;
  private readonly now: () => number;
  private readonly randomOperationId: () => string;
  private readonly limits: ApplyLimits;

  constructor(options: StudioApplyServiceOptions) {
    this.drafts = options.drafts;
    this.source = options.source;
    this.validation = options.validation;
    this.planTokens = options.planTokens;
    this.transactions = options.transactions;
    this.lockManager = options.lockManager;
    this.installedVerifier = options.installedVerifier;
    this.technicalCatalogFingerprint =
      options.technicalCatalogFingerprint;
    this.compilerContractVersion =
      options.compilerContractVersion ?? LUNA_WORKFLOW_COMPILER_SCHEMA_VERSION;
    this.lockResource = options.lockResource ?? "luna-studio-apply";
    this.now = options.now ?? Date.now;
    this.randomOperationId = options.randomOperationId ?? randomUUID;
    this.limits = resolveLimits(options.limits);
    if (
      this.compilerContractVersion.trim() === "" ||
      Buffer.byteLength(this.compilerContractVersion, "utf8") >
        CONTRACT_MAX_COMPILER_VERSION_BYTES
    ) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Compiler contract version must contain at most 256 UTF-8 bytes"
      );
    }
  }

  async plan(draftId: string): Promise<StudioApplyPlanResponse> {
    const changeSet = await this.requireDraft(draftId);
    const authority = await this.buildAuthorityPlan(changeSet);
    const base = {
      draft_id: changeSet.draft_id,
      record_revision: changeSet.record_revision,
      content_revision: changeSet.content_revision,
      draft_hash: changeSet.draft_hash,
      diff: authority.diff,
      conflicts: authority.conflicts,
      resources: changeSet.resources
    };
    if (authority.conflicts.length > 0) {
      return StudioApplyPlanResponseSchema.parse({
        ...base,
        status: "conflicted"
      });
    }
    const issued = await this.planTokens.issue(authority.stored, {
      ttlMs: this.limits.planTtlMs
    });
    return StudioApplyPlanResponseSchema.parse({
      ...base,
      status: "ready",
      plan_token: issued.token,
      expires_at: new Date(issued.expiresAt).toISOString()
    });
  }

  async apply(
    draftId: string,
    input: {
      readonly planToken: string;
      readonly idempotencyKey: string;
      readonly ifMatch: string;
    }
  ): Promise<StudioApplyResult> {
    const request = StudioApplyRequestSchema.parse({
      plan_token: input.planToken,
      idempotency_key: input.idempotencyKey
    });
    const idempotencyKeyHash = studioApplySecretDigest(
      request.idempotency_key
    );
    const planTokenHash = studioApplySecretDigest(request.plan_token);
    const requestHash = studioApplyValueDigest({
      draft_id: draftId,
      if_match: input.ifMatch,
      plan_token_hash: planTokenHash
    });

    return await this.withApplyLock(async () => {
      const previous =
        await this.transactions.findByIdempotencyKeyHash(idempotencyKeyHash);
      if (previous !== undefined) {
        if (previous.requestHash !== requestHash) {
          throw new StudioApplyError(
            "studio_apply_idempotency_conflict",
            "The idempotency key was already used for a different apply request",
            { details: { operationId: previous.operationId } }
          );
        }
        if (previous.state === "committed" && previous.result !== undefined) {
          return resultWithReplay(previous.result);
        }
        const requiresRecovery = previous.state !== "rolled_back";
        throw new StudioApplyError(
          requiresRecovery
            ? "studio_apply_recovery_required"
            : "studio_apply_previous_attempt_failed",
          requiresRecovery
            ? "A previous apply request with this idempotency key requires recovery"
            : "A previous apply request with this idempotency key did not commit",
          {
            details: {
              operationId: previous.operationId,
              state: previous.state
            }
          }
        );
      }

      const tokenRecord = await this.planTokens.get(request.plan_token);
      if (tokenRecord === undefined || tokenRecord.expiresAt <= this.currentTime()) {
        throw new StudioApplyError(
          "studio_apply_plan_expired",
          "The apply plan token is missing or expired",
          { details: { draftId } }
        );
      }
      if (tokenRecord.tokenDigest !== planTokenHash) {
        throw new StudioApplyError(
          "studio_apply_plan_invalid",
          "The apply plan token record is invalid",
          { details: { draftId } }
        );
      }

      const changeSet = await this.requireDraft(draftId);
      const actualEtag = draftEtag(changeSet);
      if (input.ifMatch !== actualEtag) {
        throw new StudioApplyError(
          "studio_apply_revision_conflict",
          "The Studio draft changed after the apply request was prepared",
          {
            details: {
              draftId,
              expectedEtag: input.ifMatch,
              actualEtag
            }
          }
        );
      }
      if (
        tokenRecord.plan.binding.draftId !== draftId ||
        tokenRecord.plan.binding.recordRevision !== changeSet.record_revision ||
        tokenRecord.plan.binding.draftHash !== changeSet.draft_hash
      ) {
        throw new StudioApplyError(
          "studio_apply_plan_stale",
          "The apply plan no longer matches the persisted draft",
          { details: { draftId } }
        );
      }

      const authority = await this.buildAuthorityPlan(changeSet);
      if (authority.conflicts.length > 0) {
        throw new StudioApplyError(
          "studio_apply_source_conflict",
          "Source files changed after the draft was opened",
          {
            details: { draftId, conflicts: authority.conflicts }
          }
        );
      }
      assertSameValue(
        authority.stored,
        tokenRecord.plan,
        "studio_apply_plan_stale",
        "The apply plan no longer matches its validation authority"
      );

      const result = await this.transactions.execute(
        {
          operationId: this.randomOperationId(),
          draftId,
          recordRevision: changeSet.record_revision,
          draftHash: changeSet.draft_hash,
          requestHash,
          idempotencyKeyHash,
          planTokenHash,
          planDigest: authority.stored.binding.planDigest,
          allowedFiles: changeSet.allowed_files,
          entries: authority.entries,
          guards: authority.guards,
          diff: authority.diff,
          verification: {
            resources: changeSet.resources,
            expectedResourceRevisions:
              authority.stored.expectedResourceRevisions,
            technicalCatalogFingerprint:
              changeSet.technical_catalog_fingerprint,
            compilerContractVersion: this.compilerContractVersion
          }
        },
        this.catalogBoundVerifier()
      );
      return StudioApplyResultSchema.parse({
        ...result,
        idempotent_replay: false
      });
    });
  }

  async recover() {
    return await this.withApplyLock(async () =>
      await this.transactions.recover(this.catalogBoundVerifier())
    );
  }

  private async buildAuthorityPlan(
    changeSet: StudioChangeSet
  ): Promise<AuthorityPlan> {
    assertStudioChangeSetIntegrity(changeSet);
    if (changeSet.changes.length === 0) {
      throw new StudioApplyError(
        "studio_apply_source_invalid",
        "A Studio apply plan must contain at least one file change",
        { details: { draftId: changeSet.draft_id } }
      );
    }
    if (
      changeSet.base_files.length + changeSet.dependencies.length >
        this.limits.maxFiles ||
      changeSet.changes.length > this.limits.maxFiles ||
      changeSet.allowed_files.length > this.limits.maxFiles ||
      changeSet.resources.length > this.limits.maxFiles
    ) {
      throw new StudioApplyError(
        "studio_apply_source_too_large",
        "Studio apply collections exceed the configured file count limit",
        { details: { draftId: changeSet.draft_id } }
      );
    }

    const currentCatalog = await this.technicalCatalogFingerprint();
    if (currentCatalog !== changeSet.technical_catalog_fingerprint) {
      throw new StudioApplyError(
        "studio_apply_plan_stale",
        "The technical capability catalog changed after the draft was created",
        { details: { draftId: changeSet.draft_id } }
      );
    }

    const budget = new ReadBudget(this.limits);
    const source = new Map<string, StudioApplySourceFile | undefined>();
    const conflicts: StudioApplyConflict[] = [];
    const expectedFiles = [
      ...changeSet.base_files.map((file) => ({
        file: file.file,
        sha256: file.sha256,
        mode: file.mode
      })),
      ...changeSet.dependencies.map((file) => ({
        file: file.file,
        sha256: file.sha256,
        mode: undefined
      }))
    ];
    for (const expected of ordered(expectedFiles, (item) => studioPathKey(item.file))) {
      const current = await this.source.read(expected.file, {
        maxBytes: budget.nextLimit(expected.file)
      });
      budget.account(expected.file, current?.content.byteLength ?? 0);
      source.set(studioPathKey(expected.file), current);
      const actual = current?.sha256 ?? null;
      const actualMode = current?.mode ?? null;
      if (
        actual !== expected.sha256 ||
        (expected.mode !== undefined && actualMode !== expected.mode)
      ) {
        conflicts.push({
          file: expected.file,
          kind: expectedConflictKind(expected.sha256, actual),
          expected_sha256: expected.sha256,
          actual_sha256: actual,
          ...(expected.mode === undefined
            ? {}
            : {
                expected_mode: expected.mode,
                actual_mode: actualMode
              })
        });
      }
    }

    const entries: StudioApplyTransactionEntry[] = [];
    const diff: StudioApplyFileDiff[] = [];
    let diffBytesRemaining = this.limits.maxDiffTotalBytes;
    for (const change of ordered(changeSet.changes, (item) => studioPathKey(item.file))) {
      const before = source.get(studioPathKey(change.file));
      const entry = await this.buildEntry(changeSet, change, before, budget);
      entries.push(entry);
      if (
        conflicts.length === 0 &&
        entry.action === "write" &&
        entry.beforeSha256 === entry.afterSha256 &&
        (entry.mode ?? before?.mode ?? 0o644) === (before?.mode ?? 0o644)
      ) {
        throw new StudioApplyError(
          "studio_apply_source_invalid",
          "Studio apply contains a no-op file write",
          { details: { draftId: changeSet.draft_id, file: change.file } }
        );
      }
      const maxTextBytes = Math.min(
        this.limits.maxDiffFileBytes,
        diffBytesRemaining
      );
      const projected = projectStudioApplyDiff({
        file: entry.file,
        kind:
          entry.action === "delete"
            ? "deleted"
            : entry.beforeSha256 === null
              ? "created"
              : "modified",
        before: before?.content,
        after: entry.content,
        beforeSha256: before?.sha256 ?? null,
        afterSha256: entry.afterSha256,
        beforeMode: before?.mode ?? null,
        afterMode: entry.action === "write" ? (entry.mode ?? 0o644) : null,
        maxTextBytes
      });
      diff.push(projected);
      diffBytesRemaining -= Buffer.byteLength(projected.textual_diff, "utf8");
    }

    const diffDigest = studioApplyValueDigest(diff);
    const bindingWithoutDigest = {
      draftId: changeSet.draft_id,
      recordRevision: changeSet.record_revision,
      contentRevision: changeSet.content_revision,
      layoutRevision: changeSet.layout_revision,
      draftHash: changeSet.draft_hash,
      baseBundleHash: changeSet.base_bundle_hash,
      baseFiles: ordered(
        changeSet.base_files.map((file) => ({
          file: file.file,
          sha256: file.sha256,
          mode: file.mode
        })),
        (file) => studioPathKey(file.file)
      ),
      dependencies: ordered(changeSet.dependencies, (dependency) =>
        studioPathKey(dependency.file)
      ),
      resourceRevisions: Object.fromEntries(
        Object.entries(changeSet.resource_revisions).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
      technicalCatalogFingerprint:
        changeSet.technical_catalog_fingerprint,
      compilerContractVersion: this.compilerContractVersion,
      diffDigest
    };
    const binding: StudioApplyPlanBinding = {
      ...bindingWithoutDigest,
      planDigest: studioApplyValueDigest(bindingWithoutDigest)
    };

    let expectedResourceRevisions: Readonly<Record<string, string>> = {};
    if (conflicts.length === 0) {
      expectedResourceRevisions = await this.validateAndCompile(changeSet);
    }
    const guards = ordered(expectedFiles, (item) => studioPathKey(item.file));
    return {
      stored: { binding, expectedResourceRevisions },
      diff,
      conflicts,
      entries,
      guards
    };
  }

  private async buildEntry(
    changeSet: StudioChangeSet,
    change: StudioDraftFileChange,
    before: StudioApplySourceFile | undefined,
    budget: ReadBudget
  ): Promise<StudioApplyTransactionEntry> {
    if (change.action === "delete") {
      return {
        file: change.file,
        action: "delete",
        beforeSha256: change.base_sha256,
        beforeMode: before?.mode ?? null,
        afterSha256: null
      };
    }
    let content: string;
    try {
      content = await this.drafts.getBlob(
        changeSet.draft_id,
        change.content_ref,
        { maxBytes: budget.nextLimit(change.file) }
      );
    } catch (cause) {
      throw new StudioApplyError(
        "studio_apply_source_invalid",
        "Unable to read a bounded Studio draft blob for apply",
        { cause, details: { draftId: changeSet.draft_id, file: change.file } }
      );
    }
    const bytes = Buffer.from(content, "utf8");
    budget.account(change.file, bytes.byteLength);
    if (studioApplyBytesDigest(bytes) !== change.content_sha256) {
      throw new StudioApplyError(
        "studio_apply_source_invalid",
        "Studio draft blob hash does not match its change set",
        { details: { draftId: changeSet.draft_id, file: change.file } }
      );
    }
    return {
      file: change.file,
      action: "write",
      beforeSha256: change.base_sha256,
      beforeMode: before?.mode ?? null,
      afterSha256: change.content_sha256,
      content: bytes,
      mode: change.mode ?? before?.mode ?? 0o644
    };
  }

  private async validateAndCompile(
    changeSet: StudioChangeSet
  ): Promise<Readonly<Record<string, string>>> {
    let validation;
    try {
      validation = await this.validation.validate(changeSet, { compile: true });
    } catch (cause) {
      throw new StudioApplyError(
        "studio_apply_validation_failed",
        "Canonical Studio validation failed before apply",
        { cause, details: { draftId: changeSet.draft_id } }
      );
    }
    if (
      validation.status !== "valid" ||
      !validation.compiled ||
      validation.draft_hash !== changeSet.draft_hash ||
      validation.record_revision !== changeSet.record_revision
    ) {
      throw new StudioApplyError(
        "studio_apply_validation_failed",
        "Canonical Studio validation did not authorize this draft revision",
        { details: { draftId: changeSet.draft_id } }
      );
    }
    const revisions = new Map<string, string>();
    for (const resource of validation.resources) {
      const key = studioResourceKey(resource.resource);
      if (resource.revision === undefined || revisions.has(key)) {
        throw new StudioApplyError(
          "studio_apply_validation_failed",
          "Canonical validation omitted or duplicated a resource revision",
          { details: { draftId: changeSet.draft_id } }
        );
      }
      revisions.set(key, resource.revision);
    }
    assertSameValue(
      [...revisions.keys()].sort(),
      changeSet.resources.map(studioResourceKey).sort(),
      "studio_apply_validation_failed",
      "Canonical validation did not cover the exact draft resource set"
    );
    return Object.fromEntries(revisions);
  }

  private catalogBoundVerifier(): StudioInstalledApplyVerificationPort {
    return {
      verify: async (context: StudioApplyVerificationContext) => {
        const currentCatalog = await this.technicalCatalogFingerprint();
        if (
          context.technicalCatalogFingerprint !== currentCatalog ||
          context.compilerContractVersion !== this.compilerContractVersion
        ) {
          throw new StudioApplyError(
            "studio_apply_plan_stale",
            "Apply verification authority changed before commit"
          );
        }
        const actual = await this.installedVerifier.verify(context);
        assertSameValue(
          actual,
          context.expectedResourceRevisions,
          "studio_apply_validation_failed",
          "Installed resource revisions differ from the confirmed apply plan"
        );
        return actual;
      }
    };
  }

  private async requireDraft(draftId: string): Promise<StudioChangeSet> {
    try {
      const draft = await this.drafts.get(draftId);
      if (draft !== undefined) {
        return draft;
      }
    } catch (cause) {
      if (
        !(cause instanceof StudioDraftPersistenceError) ||
        cause.code !== "studio_draft_not_found"
      ) {
        throw cause;
      }
    }
    throw new StudioApplyError(
      "studio_apply_draft_not_found",
      "The requested Studio draft does not exist",
      { details: { draftId } }
    );
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Studio apply clock must return a non-negative safe integer"
      );
    }
    return value;
  }

  private async withApplyLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.lockManager.acquire(
      this.lockResource,
      "exclusive"
    );
    let operationCause: unknown;
    try {
      return await operation();
    } catch (cause) {
      operationCause = cause;
      throw cause;
    } finally {
      try {
        await release();
      } catch (releaseCause) {
        throw new StudioApplyError(
          "studio_apply_recovery_required",
          "The Studio apply lock could not be released safely",
          {
            cause:
              operationCause === undefined
                ? releaseCause
                : { operation: operationCause, release: releaseCause }
          }
        );
      }
    }
  }
}
