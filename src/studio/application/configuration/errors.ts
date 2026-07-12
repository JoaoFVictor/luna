export type StudioConfigurationErrorCode =
  | "studio_configuration_request_invalid"
  | "studio_configuration_workflow_not_found"
  | "studio_configuration_not_declared"
  | "studio_configuration_schema_unavailable"
  | "studio_configuration_file_unavailable"
  | "studio_configuration_source_invalid"
  | "studio_configuration_draft_not_found"
  | "studio_configuration_draft_mismatch"
  | "studio_configuration_precondition_required"
  | "studio_configuration_precondition_failed"
  | "studio_configuration_field_not_editable"
  | "studio_configuration_value_invalid"
  | "studio_configuration_noop";

export class StudioConfigurationError extends Error {
  readonly code: StudioConfigurationErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: StudioConfigurationErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, unknown>>;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "StudioConfigurationError";
    this.code = code;
    this.details = options.details ?? {};
  }
}
