import type { StudioApplyConflict } from "../../contracts/apply.js";
import type { StudioPath } from "../../contracts/paths.js";

export type StudioApplyErrorCode =
  | "studio_apply_config_invalid"
  | "studio_apply_draft_not_found"
  | "studio_apply_revision_conflict"
  | "studio_apply_plan_expired"
  | "studio_apply_plan_invalid"
  | "studio_apply_plan_stale"
  | "studio_apply_source_conflict"
  | "studio_apply_source_invalid"
  | "studio_apply_source_too_large"
  | "studio_apply_path_invalid"
  | "studio_apply_validation_failed"
  | "studio_apply_idempotency_conflict"
  | "studio_apply_previous_attempt_failed"
  | "studio_apply_io_failed"
  | "studio_apply_rolled_back"
  | "studio_apply_recovery_required"
  | "studio_apply_journal_invalid";

export type StudioApplyErrorDetails = {
  readonly draftId?: string;
  readonly file?: StudioPath;
  readonly conflicts?: readonly StudioApplyConflict[];
  readonly expectedEtag?: string;
  readonly actualEtag?: string;
  readonly operationId?: string;
  readonly state?: string;
  readonly actualBytes?: number;
  readonly maxBytes?: number;
};

export class StudioApplyError extends Error {
  readonly code: StudioApplyErrorCode;
  readonly details: StudioApplyErrorDetails;

  constructor(
    code: StudioApplyErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: StudioApplyErrorDetails;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "StudioApplyError";
    this.code = code;
    this.details = options.details ?? {};
  }
}

/** Test-only crash seam. The transaction deliberately skips in-process rollback. */
export class StudioApplySimulatedCrash extends Error {
  constructor(message = "Simulated Studio apply process crash") {
    super(message);
    this.name = "StudioApplySimulatedCrash";
  }
}

