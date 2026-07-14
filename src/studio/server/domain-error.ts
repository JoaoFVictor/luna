import { StudioAdapterPreviewError } from "../application/inputs/input-adapters.js";
import { StudioRoutingDefinitionLoadError } from "../application/routing/router-definition-loader.js";
import {
  RUN_STORE_ERROR_CODES,
  RunStoreError,
  type RunStoreErrorCode
} from "../application/runs/errors.js";
import { studioDraftAuthoringHttpError } from "./draft-authoring-errors.js";
import {
  ARTIFACT_READER_ERROR_CODES,
  ArtifactReaderError,
  type ArtifactReaderErrorCode
} from "../application/artifacts/errors.js";
import {
  RUN_LOG_READER_ERROR_CODES,
  RunLogReaderError,
  type RunLogReaderErrorCode
} from "../application/runs/log-ports.js";
import { studioRunLaunchHttpError } from "./run-launch-errors.js";
import { studioConfigurationHttpError } from "./configuration-errors.js";
import { studioResourceHistoryHttpError } from "./resource-history-errors.js";
import { studioAgentTestHttpError } from "./agent-test-errors.js";
import { StudioRunResumeError } from "../application/runs/resume-errors.js";

export type StudioDomainHttpError = {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<
    Record<string, string | number | boolean | null>
  >;
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

const ARTIFACT_ERRORS: Readonly<
  Record<ArtifactReaderErrorCode, StudioDomainHttpError>
> = {
  artifact_backend_unsupported: { statusCode: 409, code: "artifact_backend_unsupported", message: "The artifact backend is not readable by Studio" },
  artifact_catalog_corrupt: { statusCode: 500, code: "artifact_catalog_corrupt", message: "Artifact metadata is unavailable" },
  artifact_content_changed: { statusCode: 409, code: "artifact_content_changed", message: "The artifact changed while it was being read" },
  artifact_handle_invalid: { statusCode: 400, code: "artifact_handle_invalid", message: "The artifact handle is invalid" },
  artifact_input_invalid: { statusCode: 400, code: "artifact_input_invalid", message: "The artifact request is invalid" },
  artifact_io_failed: { statusCode: 500, code: "artifact_io_failed", message: "The artifact could not be read" },
  artifact_not_found: { statusCode: 404, code: "artifact_not_found", message: "The artifact was not found" },
  artifact_security_violation: { statusCode: 403, code: "artifact_security_violation", message: "The artifact cannot be accessed safely" },
  artifact_too_large: { statusCode: 413, code: "artifact_too_large", message: "The artifact exceeds the configured limit" },
  artifact_unavailable: { statusCode: 409, code: "artifact_unavailable", message: "The artifact is not available" }
};

const RUN_LOG_ERRORS: Readonly<
  Record<RunLogReaderErrorCode, StudioDomainHttpError>
> = {
  run_log_changed: { statusCode: 409, code: "run_log_changed", message: "The run log changed during pagination" },
  run_log_cursor_expired: { statusCode: 410, code: "run_log_cursor_expired", message: "The run log cursor has expired" },
  run_log_cursor_invalid: { statusCode: 400, code: "run_log_cursor_invalid", message: "The run log cursor is invalid" },
  run_log_cursor_tampered: { statusCode: 400, code: "run_log_cursor_tampered", message: "The run log cursor is invalid" },
  run_log_input_invalid: { statusCode: 400, code: "run_log_input_invalid", message: "The run log request is invalid" },
  run_log_io_failed: { statusCode: 500, code: "run_log_io_failed", message: "The run log could not be read" },
  run_log_line_too_large: { statusCode: 413, code: "run_log_line_too_large", message: "A run log entry exceeds the configured limit" },
  run_log_security_violation: { statusCode: 403, code: "run_log_security_violation", message: "The run log cannot be accessed safely" },
  run_log_snapshot_too_large: { statusCode: 413, code: "run_log_snapshot_too_large", message: "The run log exceeds the configured limit" },
  run_log_store_corrupt: { statusCode: 500, code: "run_log_store_corrupt", message: "The run log is unavailable" }
};

// Compile-time exhaustiveness is carried by RUN_ERRORS; this runtime guard
// prevents a future code from being silently omitted by generated adapters.
if (Object.keys(RUN_ERRORS).length !== RUN_STORE_ERROR_CODES.length) {
  throw new Error("Studio run HTTP error mapping is incomplete");
}
if (Object.keys(ARTIFACT_ERRORS).length !== ARTIFACT_READER_ERROR_CODES.length) {
  throw new Error("Studio artifact HTTP error mapping is incomplete");
}
if (Object.keys(RUN_LOG_ERRORS).length !== RUN_LOG_READER_ERROR_CODES.length) {
  throw new Error("Studio run log HTTP error mapping is incomplete");
}

export function studioDomainHttpError(
  error: unknown
): StudioDomainHttpError | undefined {
  const resourceHistory = studioResourceHistoryHttpError(error);
  if (resourceHistory !== undefined) {
    return resourceHistory;
  }
  const configuration = studioConfigurationHttpError(error);
  if (configuration !== undefined) {
    return configuration;
  }
  const runLaunch = studioRunLaunchHttpError(error);
  if (runLaunch !== undefined) {
    return runLaunch;
  }
  const authoring = studioDraftAuthoringHttpError(error);
  if (authoring !== undefined) {
    return authoring;
  }
  const agentTest = studioAgentTestHttpError(error);
  if (agentTest !== undefined) {
    return agentTest;
  }
  if (error instanceof StudioAdapterPreviewError) {
    return PREVIEW_ERRORS[error.code];
  }
  if (error instanceof StudioRoutingDefinitionLoadError) {
    return routingError(error);
  }
  if (error instanceof StudioRunResumeError) {
    return {
      statusCode: 409,
      code: error.code,
      message: "The run cannot be resumed because the runtime capability catalog changed"
    };
  }
  if (error instanceof RunStoreError) {
    return RUN_ERRORS[error.code];
  }
  if (error instanceof ArtifactReaderError) {
    return ARTIFACT_ERRORS[error.code];
  }
  if (error instanceof RunLogReaderError) {
    return RUN_LOG_ERRORS[error.code];
  }
  return undefined;
}
