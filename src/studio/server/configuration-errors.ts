import { StudioConfigurationError } from "../application/configuration/errors.js";

export type StudioConfigurationHttpError = {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
};

export function studioConfigurationHttpError(
  error: unknown
): StudioConfigurationHttpError | undefined {
  if (!(error instanceof StudioConfigurationError)) return undefined;

  switch (error.code) {
    case "studio_configuration_workflow_not_found":
    case "studio_configuration_draft_not_found":
      return {
        statusCode: 404,
        code: error.code,
        message: "The requested Studio configuration was not found"
      };
    case "studio_configuration_precondition_required":
      return {
        statusCode: 428,
        code: error.code,
        message: "This configuration command requires If-Match"
      };
    case "studio_configuration_precondition_failed":
      return {
        statusCode: 412,
        code: error.code,
        message: "The configuration draft changed after the request was prepared"
      };
    case "studio_configuration_request_invalid":
    case "studio_configuration_field_not_editable":
    case "studio_configuration_value_invalid":
      return {
        statusCode: 400,
        code: error.code,
        message: "The Studio configuration command is invalid"
      };
    case "studio_configuration_not_declared":
    case "studio_configuration_schema_unavailable":
    case "studio_configuration_file_unavailable":
    case "studio_configuration_draft_mismatch":
    case "studio_configuration_noop":
      return {
        statusCode: 409,
        code: error.code,
        message: "The Studio configuration command conflicts with current state"
      };
    case "studio_configuration_source_invalid":
      return {
        statusCode: 500,
        code: error.code,
        message: "The Studio configuration source could not be read safely"
      };
  }
}
