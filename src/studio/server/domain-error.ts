import { StudioAdapterPreviewError } from "../application/inputs/input-adapters.js";
import { StudioRoutingDefinitionLoadError } from "../application/routing/router-definition-loader.js";

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

export function studioDomainHttpError(
  error: unknown
): StudioDomainHttpError | undefined {
  if (error instanceof StudioAdapterPreviewError) {
    return PREVIEW_ERRORS[error.code];
  }
  if (error instanceof StudioRoutingDefinitionLoadError) {
    return routingError(error);
  }
  return undefined;
}
