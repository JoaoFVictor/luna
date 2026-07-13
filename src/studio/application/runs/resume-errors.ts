export const STUDIO_RUN_RESUME_ERROR_CODES = [
  "studio_run_resume_catalog_changed"
] as const;

export type StudioRunResumeErrorCode =
  (typeof STUDIO_RUN_RESUME_ERROR_CODES)[number];

export class StudioRunResumeError extends Error {
  readonly code: StudioRunResumeErrorCode;

  constructor(code: StudioRunResumeErrorCode, message: string) {
    super(message);
    this.name = "StudioRunResumeError";
    this.code = code;
  }
}

export function studioRunResumeCatalogChanged(): StudioRunResumeError {
  return new StudioRunResumeError(
    "studio_run_resume_catalog_changed",
    "The run was created with a different capability catalog and cannot be resumed safely"
  );
}
