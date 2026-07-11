import {
  StudioRunLaunchError,
  type StudioRunLaunchErrorCode
} from "../application/runs/launch-errors.js";
import type { StudioDomainHttpError } from "./domain-error.js";

const RUN_LAUNCH_ERRORS: Readonly<
  Record<StudioRunLaunchErrorCode, Omit<StudioDomainHttpError, "details">>
> = {
  studio_run_launch_config_invalid: {
    statusCode: 500,
    code: "studio_run_launch_config_invalid",
    message: "The run launcher is misconfigured"
  },
  studio_run_adapter_unknown: {
    statusCode: 400,
    code: "studio_run_adapter_unknown",
    message: "The requested run input adapter is unavailable"
  },
  studio_run_adapter_effects_unacknowledged: {
    statusCode: 409,
    code: "studio_run_adapter_effects_unacknowledged",
    message: "The run input adapter effects were not acknowledged"
  },
  studio_run_adapter_failed: {
    statusCode: 502,
    code: "studio_run_adapter_failed",
    message: "The run input adapter could not resolve a valid invocation"
  },
  studio_run_routing_no_match: {
    statusCode: 409,
    code: "studio_run_routing_no_match",
    message: "The run input did not match an installed routing rule"
  },
  studio_run_routing_failed: {
    statusCode: 409,
    code: "studio_run_routing_failed",
    message: "The run input could not be routed safely"
  },
  studio_run_target_mismatch: {
    statusCode: 409,
    code: "studio_run_target_mismatch",
    message: "The invocation target conflicts with installed routing"
  },
  studio_run_interrupt_resume_unsupported: {
    statusCode: 409,
    code: "studio_run_interrupt_resume_unsupported",
    message: "This workflow can pause for input, but local resume is not available in Studio yet"
  },
  studio_run_plan_invalid: {
    statusCode: 400,
    code: "studio_run_plan_invalid",
    message: "The run plan request is invalid"
  },
  studio_run_plan_resolution_invalid: {
    statusCode: 409,
    code: "studio_run_plan_resolution_invalid",
    message: "The run plan could not resolve a valid execution"
  },
  studio_run_plan_resolution_mismatch: {
    statusCode: 409,
    code: "studio_run_plan_resolution_mismatch",
    message: "The resolved run does not match the request"
  },
  studio_run_confirmation_invalid: {
    statusCode: 409,
    code: "studio_run_confirmation_invalid",
    message: "The run confirmation is invalid, expired, or already used"
  },
  studio_run_plan_stale: {
    statusCode: 409,
    code: "studio_run_plan_stale",
    message: "The run plan changed and must be planned again"
  },
  studio_run_dispatch_failed: {
    statusCode: 503,
    code: "studio_run_dispatch_failed",
    message: "Run acceptance could not be verified; inspect the run catalog before retrying"
  },
  studio_run_dispatch_contract_invalid: {
    statusCode: 502,
    code: "studio_run_dispatch_contract_invalid",
    message: "Run acceptance could not be verified; inspect the run catalog before retrying"
  }
};

type PublicRunLaunchDetails = NonNullable<StudioDomainHttpError["details"]>;

function publicRunLaunchDetails(
  error: StudioRunLaunchError
): PublicRunLaunchDetails | undefined {
  if (error.details.acceptance_unknown === true) {
    const planId = error.details.plan_id;
    return {
      acceptance_unknown: true,
      ...(typeof planId === "string" ? { plan_id: planId } : {})
    };
  }
  if (error.code !== "studio_run_interrupt_resume_unsupported") {
    return undefined;
  }
  return {
    resume_available: false,
    can_create_pending_interrupt: true,
    ...(typeof error.details.workflow_id === "string"
      ? { workflow_id: error.details.workflow_id }
      : {}),
    ...(error.details.mode === "read_only" ||
    error.details.mode === "trusted_local_write"
      ? { mode: error.details.mode }
      : {}),
    ...(typeof error.details.interruptible_node_count === "number"
      ? { interruptible_node_count: error.details.interruptible_node_count }
      : {})
  };
}

export function studioRunLaunchHttpError(
  error: unknown
): StudioDomainHttpError | undefined {
  if (!(error instanceof StudioRunLaunchError)) {
    return undefined;
  }
  const mapped = RUN_LAUNCH_ERRORS[error.code];
  const details = publicRunLaunchDetails(error);
  return {
    ...mapped,
    ...(details === undefined ? {} : { details })
  };
}
