import { StudioApplyError } from "../application/apply/errors.js";
import { StudioDraftAuthoringError } from "../application/drafts/authoring-errors.js";
import { StudioDraftPersistenceError } from "../application/drafts/persistence.js";
import { studioPathKey } from "../contracts/paths.js";

export type StudioDraftAuthoringHttpError = {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<
    Record<string, string | number | boolean | null>
  >;
};

function dirtyFileConflictDetails(
  error: StudioDraftAuthoringError
): NonNullable<StudioDraftAuthoringHttpError["details"]> {
  const paths = (error.details.files ?? [])
    .slice(0, 3)
    .map(studioPathKey);
  const actualEntries = error.details.actualEntries ?? paths.length;
  return {
    ...(error.details.fieldPath === undefined
      ? {}
      : { field_path: error.details.fieldPath }),
    ...(error.details.file === undefined
      ? {}
      : { path: studioPathKey(error.details.file) }),
    dirty_paths: paths.join("\n"),
    dirty_path_count: actualEntries,
    dirty_paths_truncated: actualEntries > paths.length
  };
}

function authoringError(
  error: StudioDraftAuthoringError
): StudioDraftAuthoringHttpError {
  switch (error.code) {
    case "studio_draft_authoring_resource_not_found":
    case "studio_draft_authoring_not_found":
      return {
        statusCode: 404,
        code: error.code,
        message: "The requested Studio resource was not found"
      };
    case "studio_draft_authoring_precondition_required":
      return {
        statusCode: 428,
        code: error.code,
        message: "This Studio command requires If-Match"
      };
    case "studio_draft_authoring_precondition_failed":
      return {
        statusCode: 412,
        code: error.code,
        message: "The Studio draft changed after the request was prepared"
      };
    case "studio_draft_authoring_source_too_large":
    case "studio_draft_authoring_patch_too_large":
    case "studio_draft_authoring_layout_too_large":
    case "studio_draft_authoring_fixture_too_large":
      return {
        statusCode: 413,
        code: error.code,
        message: "The Studio authoring payload exceeds its configured limit"
      };
    case "studio_draft_authoring_noop":
    case "studio_draft_authoring_model_profile_unavailable":
    case "studio_draft_authoring_resource_invalid":
    case "studio_draft_authoring_fixture_conflict":
      return {
        statusCode: 409,
        code: error.code,
        message: "The Studio authoring command conflicts with current state"
      };
    case "studio_draft_authoring_dirty_file_conflict":
      return {
        statusCode: 409,
        code: error.code,
        message: "The definition change conflicts with dirty draft files",
        details: dirtyFileConflictDetails(error)
      };
    case "studio_draft_authoring_source_invalid":
    case "studio_draft_authoring_file_not_editable":
    case "studio_draft_authoring_duplicate_edit":
      return {
        statusCode: 400,
        code: error.code,
        message: "The Studio authoring command is invalid"
      };
    case "studio_draft_authoring_config_invalid":
      return {
        statusCode: 500,
        code: error.code,
        message: "Studio authoring is not configured correctly"
      };
  }
}
function persistenceError(
  error: StudioDraftPersistenceError
): StudioDraftAuthoringHttpError {
  switch (error.code) {
    case "studio_draft_not_found":
      return {
        statusCode: 404,
        code: error.code,
        message: "The requested Studio draft was not found"
      };
    case "studio_draft_revision_conflict":
      return {
        statusCode: 412,
        code: error.code,
        message: "The Studio draft changed after the request was prepared"
      };
    case "studio_draft_already_exists":
      return {
        statusCode: 409,
        code: error.code,
        message: "The Studio draft already exists"
      };
    case "studio_blob_too_large":
    case "studio_draft_too_large":
    case "studio_storage_quota_exceeded":
      return {
        statusCode: 413,
        code: error.code,
        message: "The Studio draft exceeds its configured storage limit"
      };
    case "studio_draft_id_invalid":
    case "studio_draft_invalid":
    case "studio_blob_digest_invalid":
    case "studio_blob_digest_mismatch":
    case "studio_blob_duplicate":
    case "studio_blob_unreferenced":
    case "studio_blob_content_invalid":
    case "studio_list_cursor_invalid":
    case "studio_list_limit_invalid":
      return {
        statusCode: 400,
        code: error.code,
        message: "The Studio draft request is invalid"
      };
    case "studio_draft_corrupt":
    case "studio_blob_missing":
    case "studio_blob_corrupt":
    case "studio_storage_invalid":
    case "studio_storage_io_failed":
    case "studio_storage_commit_ambiguous":
      return {
        statusCode: 500,
        code: error.code,
        message: "The Studio draft could not be read or persisted safely"
      };
  }
}

function applyError(error: StudioApplyError): StudioDraftAuthoringHttpError {
  switch (error.code) {
    case "studio_apply_draft_not_found":
      return {
        statusCode: 404,
        code: error.code,
        message: "The requested Studio draft was not found"
      };
    case "studio_apply_revision_conflict":
      return {
        statusCode: 412,
        code: error.code,
        message: "The Studio draft changed after the request was prepared"
      };
    case "studio_apply_plan_expired":
    case "studio_apply_plan_stale":
    case "studio_apply_source_conflict":
    case "studio_apply_idempotency_conflict":
      return {
        statusCode: 409,
        code: error.code,
        message: "The confirmed Studio apply plan is no longer usable"
      };
    case "studio_apply_source_too_large":
      return {
        statusCode: 413,
        code: error.code,
        message: "The Studio apply source exceeds its configured limit"
      };
    case "studio_apply_plan_invalid":
    case "studio_apply_source_invalid":
    case "studio_apply_path_invalid":
    case "studio_apply_validation_failed":
      return {
        statusCode: 400,
        code: error.code,
        message: "The Studio apply command is invalid"
      };
    case "studio_apply_previous_attempt_failed":
    case "studio_apply_io_failed":
    case "studio_apply_rolled_back":
    case "studio_apply_recovery_required":
    case "studio_apply_journal_invalid":
    case "studio_apply_config_invalid":
      return {
        statusCode: 500,
        code: error.code,
        message: "The Studio apply command could not be completed safely"
      };
  }
}

/** Safe mapping hook for the Control API's existing centralized error handler. */
export function studioDraftAuthoringHttpError(
  error: unknown
): StudioDraftAuthoringHttpError | undefined {
  if (error instanceof StudioDraftAuthoringError) {
    return authoringError(error);
  }
  if (error instanceof StudioDraftPersistenceError) {
    return persistenceError(error);
  }
  if (error instanceof StudioApplyError) {
    return applyError(error);
  }
  return undefined;
}
