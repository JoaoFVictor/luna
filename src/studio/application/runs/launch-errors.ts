export const STUDIO_RUN_LAUNCH_ERROR_CODES = [
  "studio_run_launch_config_invalid",
  "studio_run_adapter_unknown",
  "studio_run_adapter_effects_unacknowledged",
  "studio_run_adapter_failed",
  "studio_run_routing_no_match",
  "studio_run_routing_failed",
  "studio_run_target_mismatch",
  "studio_run_interrupt_resume_unsupported",
  "studio_run_test_data_invalid",
  "studio_run_test_data_unavailable",
  "studio_run_test_data_stale",
  "studio_run_plan_invalid",
  "studio_run_repository_unavailable",
  "studio_run_repository_not_ready",
  "studio_run_plan_resolution_invalid",
  "studio_run_plan_resolution_mismatch",
  "studio_run_confirmation_invalid",
  "studio_run_plan_stale",
  "studio_run_dispatch_failed",
  "studio_run_dispatch_contract_invalid"
] as const;

export type StudioRunLaunchErrorCode =
  (typeof STUDIO_RUN_LAUNCH_ERROR_CODES)[number];

export class StudioRunLaunchError extends Error {
  readonly code: StudioRunLaunchErrorCode;
  readonly details: Readonly<
    Record<string, string | number | boolean | null>
  >;

  constructor(
    code: StudioRunLaunchErrorCode,
    message: string,
    details: Readonly<
      Record<string, string | number | boolean | null>
    > = {},
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "StudioRunLaunchError";
    this.code = code;
    this.details = details;
  }
}

export function studioRunLaunchError(
  code: StudioRunLaunchErrorCode,
  message: string,
  details: Readonly<
    Record<string, string | number | boolean | null>
  > = {},
  options?: ErrorOptions
): StudioRunLaunchError {
  return new StudioRunLaunchError(code, message, details, options);
}
