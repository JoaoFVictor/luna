import { StudioAdapterPreviewError } from "../application/inputs/input-adapters.js";
import { StudioRoutingDefinitionLoadError } from "../application/routing/router-definition-loader.js";
import {
  RUN_STORE_ERROR_CODES,
  RunStoreError,
  type RunStoreErrorCode
} from "../application/runs/errors.js";

export type StudioDomainHttpError = {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
};

const PREVIEW_ERRORS: Readonly<
  Record<
    StudioAdapterPreviewError["code"],
    StudioDomainHttpError
  >
> = {
  studio_adapter_preview_aborted: {
    statusCode: 408,
    code: "studio_adapter_preview_aborted",
    message: "The adapter preview was cancelled"
  },
  studio_adapter_preview_disabled: {
    statusCode: 409,
    code: "studio_adapter_preview_disabled",
    message: "Preview is not enabled for this adapter"
  },
  studio_adapter_preview_effects_unacknowledged: {
    statusCode: 409,
    code: "studio_adapter_preview_effects_unacknowledged",
    message: "The adapter preview effects were not acknowledged"
  },
  studio_adapter_preview_failed: {
    statusCode: 502,
    code: "studio_adapter_preview_failed",
    message: "The adapter preview failed"
  },
  studio_adapter_preview_invalid_request: {
    statusCode: 400,
    code: "studio_adapter_preview_invalid_request",
    message: "The adapter preview request is invalid"
  },
  studio_adapter_preview_invalid_result: {
    statusCode: 502,
    code: "studio_adapter_preview_invalid_result",
    message: "The adapter returned an invalid preview"
  },
  studio_adapter_preview_source_mismatch: {
    statusCode: 502,
    code: "studio_adapter_preview_source_mismatch",
    message: "The adapter returned an unexpected source"
  },
  studio_adapter_preview_timeout: {
    statusCode: 504,
    code: "studio_adapter_preview_timeout",
    message: "The adapter preview timed out"
  },
  studio_adapter_preview_unknown_adapter: {
    statusCode: 404,
    code: "studio_adapter_preview_unknown_adapter",
    message: "The requested adapter was not found"
  }
};

function routingError(
  error: StudioRoutingDefinitionLoadError
): StudioDomainHttpError {
  switch (error.code) {
    case "studio_routing_path_invalid":
      return {
        statusCode: 400,
        code: error.code,
        message: "The routing configuration path is invalid"
      };
    case "studio_routing_path_escape":
      return {
        statusCode: 400,
        code: error.code,
        message: "The routing configuration path escapes its root"
      };
    case "studio_routing_load_failed":
      return {
        statusCode: 500,
        code: error.code,
        message: "The routing configuration could not be loaded"
      };
  }
}

const RUN_ERRORS: Readonly<Record<RunStoreErrorCode, StudioDomainHttpError>> = {
  run_already_exists: {
    statusCode: 409,
    code: "run_already_exists",
    message: "The run already exists"
  },
  run_cursor_invalid: {
    statusCode: 400,
    code: "run_cursor_invalid",
    message: "The run cursor is invalid"
  },
  run_cursor_expired: {
    statusCode: 410,
    code: "run_cursor_expired",
    message: "The run cursor has expired"
  },
  run_cursor_tampered: {
    statusCode: 400,
    code: "run_cursor_tampered",
    message: "The run cursor is invalid"
  },
  run_event_id_conflict: {
    statusCode: 409,
    code: "run_event_id_conflict",
    message: "The run event conflicts with existing state"
  },
  run_event_sequence_conflict: {
    statusCode: 409,
    code: "run_event_sequence_conflict",
    message: "The run event sequence changed"
  },
  run_idempotency_conflict: {
    statusCode: 409,
    code: "run_idempotency_conflict",
    message: "The run request conflicts with an earlier request"
  },
  run_invalid_input: {
    statusCode: 400,
    code: "run_invalid_input",
    message: "The run request is invalid"
  },
  run_not_found: {
    statusCode: 404,
    code: "run_not_found",
    message: "The requested run was not found"
  },
  run_owner_conflict: {
    statusCode: 409,
    code: "run_owner_conflict",
    message: "The run is owned by another executor"
  },
  run_revision_conflict: {
    statusCode: 409,
    code: "run_revision_conflict",
    message: "The run changed before this request completed"
  },
  run_store_busy: {
    statusCode: 503,
    code: "run_store_busy",
    message: "The run store is busy"
  },
  run_store_closed: {
    statusCode: 503,
    code: "run_store_closed",
    message: "The run store is unavailable"
  },
  run_store_corrupt: {
    statusCode: 500,
    code: "run_store_corrupt",
    message: "The run store is unavailable"
  },
  run_store_io_failed: {
    statusCode: 500,
    code: "run_store_io_failed",
    message: "The run store could not complete the request"
  },
  run_store_schema_unsupported: {
    statusCode: 500,
    code: "run_store_schema_unsupported",
    message: "The run store schema is unsupported"
  },
  run_terminal_immutable: {
    statusCode: 409,
    code: "run_terminal_immutable",
    message: "The terminal run cannot be changed"
  },
  run_transition_invalid: {
    statusCode: 409,
    code: "run_transition_invalid",
    message: "The run transition is invalid"
  }
};

// Compile-time exhaustiveness is carried by RUN_ERRORS; this runtime guard
// prevents a future code from being silently omitted by generated adapters.
if (Object.keys(RUN_ERRORS).length !== RUN_STORE_ERROR_CODES.length) {
  throw new Error("Studio run HTTP error mapping is incomplete");
}

export function studioDomainHttpError(
  error: unknown
): StudioDomainHttpError | undefined {
  if (error instanceof StudioAdapterPreviewError) {
    return PREVIEW_ERRORS[error.code];
  }
  if (error instanceof StudioRoutingDefinitionLoadError) {
    return routingError(error);
  }
  if (error instanceof RunStoreError) {
    return RUN_ERRORS[error.code];
  }
  return undefined;
}
