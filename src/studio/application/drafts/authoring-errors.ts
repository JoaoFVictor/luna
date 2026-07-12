import type { StudioPath } from "../../contracts/paths.js";

export type StudioDraftAuthoringErrorCode =
  | "studio_draft_authoring_config_invalid"
  | "studio_draft_authoring_model_profile_unavailable"
  | "studio_draft_authoring_resource_invalid"
  | "studio_draft_authoring_resource_not_found"
  | "studio_draft_authoring_source_invalid"
  | "studio_draft_authoring_source_too_large"
  | "studio_draft_authoring_file_not_editable"
  | "studio_draft_authoring_duplicate_edit"
  | "studio_draft_authoring_patch_too_large"
  | "studio_draft_authoring_layout_too_large"
  | "studio_draft_authoring_fixture_too_large"
  | "studio_draft_authoring_fixture_conflict"
  | "studio_draft_authoring_dirty_file_conflict"
  | "studio_draft_authoring_noop"
  | "studio_draft_authoring_not_found"
  | "studio_draft_authoring_precondition_required"
  | "studio_draft_authoring_precondition_failed";

export type StudioDraftAuthoringErrorDetails = {
  readonly draftId?: string;
  readonly file?: StudioPath;
  readonly files?: readonly StudioPath[];
  readonly fieldPath?: string;
  readonly actualBytes?: number;
  readonly maxBytes?: number;
  readonly actualEntries?: number;
  readonly actualEtag?: string;
};

export class StudioDraftAuthoringError extends Error {
  readonly code: StudioDraftAuthoringErrorCode;
  readonly details: StudioDraftAuthoringErrorDetails;

  constructor(
    code: StudioDraftAuthoringErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: StudioDraftAuthoringErrorDetails;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "StudioDraftAuthoringError";
    this.code = code;
    this.details = options.details ?? {};
  }
}
