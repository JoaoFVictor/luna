export const STUDIO_AGENT_TEST_ERROR_CODES = [
  "studio_agent_test_config_invalid",
  "studio_agent_test_request_invalid",
  "studio_agent_test_target_not_found",
  "studio_agent_test_target_invalid",
  "studio_agent_test_target_stale",
  "studio_agent_test_model_profile_unavailable",
  "studio_agent_test_runtime_unavailable",
  "studio_agent_test_plan_stale",
  "studio_agent_test_confirmation_invalid",
  "studio_agent_test_execution_blocked",
  "studio_agent_test_output_invalid",
  "studio_agent_test_runtime_failed",
  "studio_agent_test_outcome_unknown"
] as const;

export type StudioAgentTestErrorCode =
  (typeof STUDIO_AGENT_TEST_ERROR_CODES)[number];

export class StudioAgentTestError extends Error {
  readonly code: StudioAgentTestErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: StudioAgentTestErrorCode,
    message: string,
    options: {
      readonly details?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "StudioAgentTestError";
    this.code = code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export function studioAgentTestError(
  code: StudioAgentTestErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  options: { readonly cause?: unknown } = {}
): StudioAgentTestError {
  return new StudioAgentTestError(code, message, {
    details,
    ...(options.cause === undefined ? {} : { cause: options.cause })
  });
}
