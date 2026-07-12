import {
  StudioAgentTestError,
  type StudioAgentTestErrorCode
} from "../application/agents/test-bench-errors.js";
import type { StudioDomainHttpError } from "./domain-error.js";

const AGENT_TEST_ERRORS: Readonly<
  Record<StudioAgentTestErrorCode, StudioDomainHttpError>
> = {
  studio_agent_test_config_invalid: {
    statusCode: 500,
    code: "studio_agent_test_config_invalid",
    message: "Agent smoke testing is not configured correctly"
  },
  studio_agent_test_request_invalid: {
    statusCode: 400,
    code: "studio_agent_test_request_invalid",
    message: "The agent smoke test request is invalid"
  },
  studio_agent_test_target_not_found: {
    statusCode: 404,
    code: "studio_agent_test_target_not_found",
    message: "The requested agent smoke target was not found"
  },
  studio_agent_test_target_invalid: {
    statusCode: 409,
    code: "studio_agent_test_target_invalid",
    message: "The requested agent smoke target cannot be tested safely"
  },
  studio_agent_test_target_stale: {
    statusCode: 409,
    code: "studio_agent_test_target_stale",
    message: "The agent target changed and must be selected again"
  },
  studio_agent_test_model_profile_unavailable: {
    statusCode: 409,
    code: "studio_agent_test_model_profile_unavailable",
    message: "The selected model profile is not currently loaded"
  },
  studio_agent_test_runtime_unavailable: {
    statusCode: 503,
    code: "studio_agent_test_runtime_unavailable",
    message: "The configured agent runtime is unavailable"
  },
  studio_agent_test_plan_stale: {
    statusCode: 409,
    code: "studio_agent_test_plan_stale",
    message: "The agent smoke plan changed and must be planned again"
  },
  studio_agent_test_confirmation_invalid: {
    statusCode: 409,
    code: "studio_agent_test_confirmation_invalid",
    message: "The agent smoke confirmation is invalid, expired, or already used"
  },
  studio_agent_test_execution_blocked: {
    statusCode: 409,
    code: "studio_agent_test_execution_blocked",
    message: "The agent smoke execution is blocked by the safety policy"
  },
  studio_agent_test_output_invalid: {
    statusCode: 502,
    code: "studio_agent_test_output_invalid",
    message: "The model response did not match the agent output contract"
  },
  studio_agent_test_runtime_failed: {
    statusCode: 502,
    code: "studio_agent_test_runtime_failed",
    message: "The agent runtime rejected the smoke test"
  },
  studio_agent_test_outcome_unknown: {
    statusCode: 503,
    code: "studio_agent_test_outcome_unknown",
    message: "The real model call outcome could not be verified"
  }
};

function publicOutcomeDetails(
  error: StudioAgentTestError
): StudioDomainHttpError["details"] | undefined {
  if (error.code !== "studio_agent_test_outcome_unknown") {
    return undefined;
  }
  const planId = error.details.plan_id;
  return {
    outcome_unknown: true,
    ...(typeof planId === "string" ? { plan_id: planId } : {})
  };
}

export function studioAgentTestHttpError(
  error: unknown
): StudioDomainHttpError | undefined {
  if (!(error instanceof StudioAgentTestError)) {
    return undefined;
  }
  const mapped = AGENT_TEST_ERRORS[error.code];
  const details = publicOutcomeDetails(error);
  return {
    ...mapped,
    ...(details === undefined ? {} : { details })
  };
}
