import {
  STUDIO_RESOURCE_HISTORY_ERROR_CODES,
  StudioResourceHistoryError,
  type StudioResourceHistoryErrorCode
} from "../application/history/errors.js";
import type { StudioDomainHttpError } from "./domain-error.js";

const HISTORY_ERRORS: Readonly<
  Record<StudioResourceHistoryErrorCode, StudioDomainHttpError>
> = {
  studio_history_unavailable: {
    statusCode: 409,
    code: "studio_history_unavailable",
    message: "Git history is unavailable for this Studio project"
  },
  studio_history_revision_not_reachable: {
    statusCode: 404,
    code: "studio_history_revision_not_reachable",
    message: "The selected revision is not available on the current branch"
  },
  studio_history_resource_not_found: {
    statusCode: 404,
    code: "studio_history_resource_not_found",
    message: "The resource does not exist at the selected revision"
  },
  studio_history_resource_invalid: {
    statusCode: 409,
    code: "studio_history_resource_invalid",
    message: "The historical resource cannot be represented safely"
  },
  studio_history_source_too_large: {
    statusCode: 413,
    code: "studio_history_source_too_large",
    message: "The historical resource exceeds Studio limits"
  },
  studio_history_git_failed: {
    statusCode: 500,
    code: "studio_history_git_failed",
    message: "Git history could not be read safely"
  },
  studio_history_restore_noop: {
    statusCode: 409,
    code: "studio_history_restore_noop",
    message: "The selected revision already matches current source"
  }
};

if (
  Object.keys(HISTORY_ERRORS).length !==
  STUDIO_RESOURCE_HISTORY_ERROR_CODES.length
) {
  throw new Error("Studio resource history HTTP error mapping is incomplete");
}

export function studioResourceHistoryHttpError(
  error: unknown
): StudioDomainHttpError | undefined {
  return error instanceof StudioResourceHistoryError
    ? HISTORY_ERRORS[error.code]
    : undefined;
}
