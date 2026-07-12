import { randomUUID } from "node:crypto";
import { LUNA_WORKFLOW_COMPILER_SCHEMA_VERSION } from "../../../core/workflow/definition-revision.js";
import type { StudioDraftValidationService } from "../validation/draft-validation.js";
import { studioDraftEtag } from "../drafts/versioning.js";
import {
  StudioDraftPersistenceError,
  type StudioDraftPersistencePort
} from "../drafts/persistence.js";
import {
  StudioApplyPlanResponseSchema,
  StudioApplyRequestSchema,
  StudioApplyResultSchema,
  type StudioApplyPlanResponse,
  type StudioApplyResult
} from "../../contracts/apply.js";
import type { StudioChangeSet } from "../../contracts/drafts.js";
import { assertSameStudioApplyValue } from "./assertions.js";
import { StudioApplyAuthorityPlanner } from "./authority-plan.js";
import {
  studioApplySecretDigest,
  studioApplyValueDigest
} from "./digests.js";
import { StudioApplyError } from "./errors.js";
import {
  resolveStudioApplyLimits,
  STUDIO_APPLY_MAX_COMPILER_VERSION_BYTES,
  type StudioApplyLimits
} from "./limits.js";
import type {
  StudioApplyLockPort,
  StudioApplyPlanTokenPort,
  StudioApplySourcePort,
  StudioApplyTransactionPort,
  StudioApplyVerificationContext,
  StudioInstalledApplyVerificationPort
} from "./ports.js";
import {
  assertStudioApplyScope,
  type StudioApplyScope
} from "./scope.js";

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
  readonly limits?: Partial<StudioApplyLimits>;
};

function resultWithReplay(result: StudioApplyResult): StudioApplyResult {
  return StudioApplyResultSchema.parse({
    ...result,
    idempotent_replay: true
  });
}

export class StudioApplyService {
  readonly #drafts: StudioDraftPersistencePort;
  readonly #authorityPlanner: StudioApplyAuthorityPlanner;
  readonly #planTokens: StudioApplyPlanTokenPort;
  readonly #transactions: StudioApplyTransactionPort;
  readonly #lockManager: StudioApplyLockPort;
  readonly #installedVerifier: StudioInstalledApplyVerificationPort;
  readonly #technicalCatalogFingerprint: () => Promise<string> | string;
  readonly #compilerContractVersion: string;
  readonly #lockResource: string;
  readonly #now: () => number;
  readonly #randomOperationId: () => string;
  readonly #planTtlMs: number;

  constructor(options: StudioApplyServiceOptions) {
    this.#drafts = options.drafts;
    this.#planTokens = options.planTokens;
    this.#transactions = options.transactions;
    this.#lockManager = options.lockManager;
    this.#installedVerifier = options.installedVerifier;
    this.#technicalCatalogFingerprint =
      options.technicalCatalogFingerprint;
    this.#compilerContractVersion =
      options.compilerContractVersion ?? LUNA_WORKFLOW_COMPILER_SCHEMA_VERSION;
    this.#lockResource = options.lockResource ?? "luna-studio-apply";
    this.#now = options.now ?? Date.now;
    this.#randomOperationId = options.randomOperationId ?? randomUUID;
    const limits = resolveStudioApplyLimits(options.limits);
    this.#planTtlMs = limits.planTtlMs;
    if (
      this.#compilerContractVersion.trim() === "" ||
      Buffer.byteLength(this.#compilerContractVersion, "utf8") >
        STUDIO_APPLY_MAX_COMPILER_VERSION_BYTES
    ) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Compiler contract version must contain at most 256 UTF-8 bytes"
      );
    }
    this.#authorityPlanner = new StudioApplyAuthorityPlanner({
      drafts: options.drafts,
      source: options.source,
      validation: options.validation,
      technicalCatalogFingerprint: options.technicalCatalogFingerprint,
      compilerContractVersion: this.#compilerContractVersion,
      limits
    });
  }

  async plan(
    draftId: string,
    scope: StudioApplyScope
  ): Promise<StudioApplyPlanResponse> {
    const changeSet = await this.#requireDraft(draftId);
    assertStudioApplyScope(changeSet, scope);
    const authority = await this.#authorityPlanner.build(changeSet);
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
    const issued = await this.#planTokens.issue(authority.stored, {
      ttlMs: this.#planTtlMs
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
    },
    scope: StudioApplyScope
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
      plan_token_hash: planTokenHash,
      scope
    });

    return await this.#withApplyLock(async () => {
      const previous =
        await this.#transactions.findByIdempotencyKeyHash(idempotencyKeyHash);
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

      const tokenRecord = await this.#planTokens.get(request.plan_token);
      if (
        tokenRecord === undefined ||
        tokenRecord.expiresAt <= this.#currentTime()
      ) {
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

      const changeSet = await this.#requireDraft(draftId);
      assertStudioApplyScope(changeSet, scope);
      const actualEtag = studioDraftEtag(changeSet);
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

      const authority = await this.#authorityPlanner.build(changeSet);
      if (authority.conflicts.length > 0) {
        throw new StudioApplyError(
          "studio_apply_source_conflict",
          "Source files changed after the draft was opened",
          { details: { draftId, conflicts: authority.conflicts } }
        );
      }
      assertSameStudioApplyValue(
        authority.stored,
        tokenRecord.plan,
        "studio_apply_plan_stale",
        "The apply plan no longer matches its validation authority"
      );

      const result = await this.#transactions.execute(
        {
          operationId: this.#randomOperationId(),
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
            compilerContractVersion: this.#compilerContractVersion
          }
        },
        this.#catalogBoundVerifier()
      );
      return StudioApplyResultSchema.parse({
        ...result,
        idempotent_replay: false
      });
    });
  }

  async recover() {
    return await this.#withApplyLock(async () =>
      await this.#transactions.recover(this.#catalogBoundVerifier())
    );
  }

  #catalogBoundVerifier(): StudioInstalledApplyVerificationPort {
    return {
      verify: async (context: StudioApplyVerificationContext) => {
        const currentCatalog = await this.#technicalCatalogFingerprint();
        if (
          context.technicalCatalogFingerprint !== currentCatalog ||
          context.compilerContractVersion !== this.#compilerContractVersion
        ) {
          throw new StudioApplyError(
            "studio_apply_plan_stale",
            "Apply verification authority changed before commit"
          );
        }
        const actual = await this.#installedVerifier.verify(context);
        assertSameStudioApplyValue(
          actual,
          context.expectedResourceRevisions,
          "studio_apply_validation_failed",
          "Installed resource revisions differ from the confirmed apply plan"
        );
        return actual;
      }
    };
  }

  async #requireDraft(draftId: string): Promise<StudioChangeSet> {
    try {
      const draft = await this.#drafts.get(draftId);
      if (draft !== undefined) return draft;
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

  #currentTime(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Studio apply clock must return a non-negative safe integer"
      );
    }
    return value;
  }

  async #withApplyLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.#lockManager.acquire(
      this.#lockResource,
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
