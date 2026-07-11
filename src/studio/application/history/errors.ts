import type { StudioHistoryResource } from "../../contracts/resource-history.js";

export const STUDIO_RESOURCE_HISTORY_ERROR_CODES = [
  "studio_history_unavailable",
  "studio_history_revision_not_reachable",
  "studio_history_resource_not_found",
  "studio_history_resource_invalid",
  "studio_history_source_too_large",
  "studio_history_git_failed",
  "studio_history_restore_noop"
] as const;

export type StudioResourceHistoryErrorCode =
  (typeof STUDIO_RESOURCE_HISTORY_ERROR_CODES)[number];

export type StudioResourceHistoryErrorDetails = {
  readonly resource?: StudioHistoryResource;
  readonly actualBytes?: number;
  readonly maxBytes?: number;
  readonly actualFiles?: number;
  readonly maxFiles?: number;
};

export class StudioResourceHistoryError extends Error {
  readonly code: StudioResourceHistoryErrorCode;
  readonly details: StudioResourceHistoryErrorDetails;

  constructor(
    code: StudioResourceHistoryErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: StudioResourceHistoryErrorDetails;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "StudioResourceHistoryError";
    this.code = code;
    this.details = options.details ?? {};
  }
}
