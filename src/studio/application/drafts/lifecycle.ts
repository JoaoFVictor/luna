import { randomUUID } from "node:crypto";
import { StudioDigestSchema } from "../../contracts/digests.js";
import type { StudioChangeSet } from "../../contracts/drafts.js";
import type {
  StudioApplyPlanResponse,
  StudioApplyResult
} from "../../contracts/apply.js";
import type { StudioApplyService } from "../apply/service.js";
import type { StudioApplyScope } from "../apply/scope.js";
import {
  createStudioChangeSet,
  replaceStudioDraftStatus,
  type CreateStudioChangeSetInput
} from "./change-set.js";
import type { StudioCatalogFingerprintPort } from "./authoring-ports.js";
import {
  StudioDraftPersistenceError,
  type StudioDraftBlob,
  type StudioDraftPersistencePort
} from "./persistence.js";
import { studioDraftEtag, studioDraftVersion } from "./versioning.js";

export type StudioDraftLifecycleConflictPhase =
  | "update"
  | "validation_update"
  | "validation_readback"
  | "if_match"
  | "delete";

export type StudioDraftLifecycleFailure =
  | {
      readonly kind: "clock_invalid";
      readonly cause?: unknown;
    }
  | {
      readonly kind: "catalog_fingerprint_invalid";
      readonly catalog: "technical" | "presentation";
    }
  | {
      readonly kind: "draft_missing";
      readonly draftId: string;
    }
  | {
      readonly kind: "precondition_required";
      readonly draftId: string;
    }
  | {
      readonly kind: "apply_unavailable";
    }
  | {
      readonly kind: "revision_conflict";
      readonly phase: StudioDraftLifecycleConflictPhase;
      readonly draftId: string;
      readonly actualEtag?: string;
      readonly cause?: unknown;
    };

export type StudioDraftLifecycleErrorFactory = (
  failure: StudioDraftLifecycleFailure
) => Error;

export type StudioDraftLifecycleOptions = {
  readonly drafts: StudioDraftPersistencePort;
  readonly catalogs: StudioCatalogFingerprintPort;
  readonly apply?: Pick<StudioApplyService, "plan" | "apply">;
  readonly errors: StudioDraftLifecycleErrorFactory;
  readonly now?: () => Date;
  readonly randomDraftId?: () => string;
};

export type StudioDraftLifecycleCreateInput = Omit<
  CreateStudioChangeSetInput,
  | "draftId"
  | "technicalCatalogFingerprint"
  | "presentationCatalogFingerprint"
  | "now"
> & {
  readonly blobs: readonly StudioDraftBlob[];
};

export type StudioDraftLifecycleUpdateInput = {
  readonly current: StudioChangeSet;
  readonly mutate: (timestamp: string) => {
    readonly changeSet: StudioChangeSet;
    readonly blobs: readonly StudioDraftBlob[];
  };
  readonly phase?: Extract<
    StudioDraftLifecycleConflictPhase,
    "update" | "validation_update"
  >;
};

/**
 * Canonical authority for the persistence lifecycle shared by every Studio
 * draft surface. Domain services supply only their public error projection.
 */
export class StudioDraftLifecycle {
  readonly #drafts: StudioDraftPersistencePort;
  readonly #catalogs: StudioCatalogFingerprintPort;
  readonly #apply: Pick<StudioApplyService, "plan" | "apply"> | undefined;
  readonly #errors: StudioDraftLifecycleErrorFactory;
  readonly #now: () => Date;
  readonly #randomDraftId: () => string;
  #lastTimestampMs = Number.NEGATIVE_INFINITY;

  constructor(options: StudioDraftLifecycleOptions) {
    this.#drafts = options.drafts;
    this.#catalogs = options.catalogs;
    this.#apply = options.apply;
    this.#errors = options.errors;
    this.#now = options.now ?? (() => new Date());
    this.#randomDraftId = options.randomDraftId ?? randomUUID;
  }

  async create(
    input: StudioDraftLifecycleCreateInput
  ): Promise<StudioChangeSet> {
    const [technical, presentation] = await Promise.all([
      this.#catalogs.technical(),
      this.#catalogs.presentation()
    ]);
    const { blobs, ...definition } = input;
    const changeSet = createStudioChangeSet({
      ...definition,
      draftId: this.#randomDraftId(),
      technicalCatalogFingerprint: this.#fingerprint(
        technical,
        "technical"
      ),
      presentationCatalogFingerprint: this.#fingerprint(
        presentation,
        "presentation"
      ),
      now: this.#timestamp()
    });
    return await this.#drafts.create({
      changeSet,
      blobs
    });
  }

  async require(draftId: string): Promise<StudioChangeSet> {
    const draft = await this.#drafts.get(draftId);
    if (draft !== undefined) return draft;
    throw this.#errors({ kind: "draft_missing", draftId });
  }

  assertIfMatch(
    current: StudioChangeSet,
    ifMatch: string | undefined
  ): string {
    const required = this.requireIfMatch(current.draft_id, ifMatch);
    const actualEtag = studioDraftEtag(current);
    if (required !== actualEtag) {
      throw this.#errors({
        kind: "revision_conflict",
        phase: "if_match",
        draftId: current.draft_id,
        actualEtag
      });
    }
    return required;
  }

  requireIfMatch(draftId: string, ifMatch: string | undefined): string {
    if (ifMatch === undefined || ifMatch.trim() === "") {
      throw this.#errors({
        kind: "precondition_required",
        draftId
      });
    }
    return ifMatch;
  }

  async updateCas(
    input: StudioDraftLifecycleUpdateInput
  ): Promise<StudioChangeSet> {
    const mutation = input.mutate(
      this.#timestamp(input.current.updated_at)
    );
    try {
      return await this.#drafts.update({
        changeSet: mutation.changeSet,
        expectedVersion: studioDraftVersion(input.current),
        blobs: mutation.blobs
      });
    } catch (cause) {
      if (!this.#isRevisionConflict(cause)) throw cause;
      return await this.#throwRevisionConflict(
        input.current,
        input.phase ?? "update",
        cause
      );
    }
  }

  async persistValidation(
    current: StudioChangeSet,
    targetStatus: "valid" | "invalid"
  ): Promise<StudioChangeSet> {
    if (current.status !== targetStatus) {
      return await this.updateCas({
        current,
        mutate: (timestamp) =>
          ({
            changeSet: replaceStudioDraftStatus(
              current,
              targetStatus,
              timestamp
            ),
            blobs: []
          }),
        phase: "validation_update"
      });
    }

    const latest = await this.#drafts.get(current.draft_id);
    if (latest === undefined) {
      throw this.#errors({
        kind: "draft_missing",
        draftId: current.draft_id
      });
    }
    if (studioDraftEtag(latest) !== studioDraftEtag(current)) {
      throw this.#errors({
        kind: "revision_conflict",
        phase: "validation_readback",
        draftId: current.draft_id,
        actualEtag: studioDraftEtag(latest)
      });
    }
    return latest;
  }

  async deleteCas(current: StudioChangeSet): Promise<void> {
    try {
      await this.#drafts.delete({
        draftId: current.draft_id,
        expectedVersion: studioDraftVersion(current)
      });
    } catch (cause) {
      if (!this.#isRevisionConflict(cause)) throw cause;
      await this.#throwRevisionConflict(current, "delete", cause);
    }
  }

  async planApply(
    draftId: string,
    scope: StudioApplyScope
  ): Promise<StudioApplyPlanResponse> {
    if (this.#apply === undefined) {
      throw this.#errors({ kind: "apply_unavailable" });
    }
    return await this.#apply.plan(draftId, scope);
  }

  async applyDraft(
    draftId: string,
    input: {
      readonly planToken: string;
      readonly idempotencyKey: string;
      readonly ifMatch: string;
    },
    scope: StudioApplyScope
  ): Promise<StudioApplyResult> {
    if (this.#apply === undefined) {
      throw this.#errors({ kind: "apply_unavailable" });
    }
    return await this.#apply.apply(draftId, input, scope);
  }

  #fingerprint(
    value: string,
    catalog: "technical" | "presentation"
  ): string {
    const parsed = StudioDigestSchema.safeParse(value);
    if (!parsed.success) {
      throw this.#errors({
        kind: "catalog_fingerprint_invalid",
        catalog
      });
    }
    return parsed.data;
  }

  #timestamp(after?: string): string {
    let value: Date;
    try {
      value = this.#now();
    } catch (cause) {
      throw this.#errors({ kind: "clock_invalid", cause });
    }
    const wallTimeMs =
      value instanceof Date ? value.getTime() : Number.NaN;
    const persistedTimeMs =
      after === undefined ? Number.NEGATIVE_INFINITY : Date.parse(after);
    const timestampMs = Math.max(
      wallTimeMs,
      this.#lastTimestampMs + 1,
      persistedTimeMs + 1
    );
    const timestamp = new Date(timestampMs);
    if (
      !Number.isFinite(wallTimeMs) ||
      !Number.isFinite(timestamp.getTime())
    ) {
      throw this.#errors({ kind: "clock_invalid" });
    }
    this.#lastTimestampMs = timestampMs;
    return timestamp.toISOString();
  }

  #isRevisionConflict(cause: unknown): boolean {
    return (
      cause instanceof StudioDraftPersistenceError &&
      cause.code === "studio_draft_revision_conflict"
    );
  }

  async #throwRevisionConflict(
    current: StudioChangeSet,
    phase: StudioDraftLifecycleConflictPhase,
    cause: unknown
  ): Promise<never> {
    let actualEtag: string | undefined;
    try {
      const latest = await this.#drafts.get(current.draft_id);
      actualEtag = latest === undefined ? undefined : studioDraftEtag(latest);
    } catch {
      // The original authoritative CAS failure must not be masked by a
      // best-effort diagnostic read.
    }
    throw this.#errors({
      kind: "revision_conflict",
      phase,
      draftId: current.draft_id,
      ...(actualEtag === undefined ? {} : { actualEtag }),
      cause
    });
  }
}
