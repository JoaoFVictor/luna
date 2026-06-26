export type RuntimeErrorCode =
  | "runtime_checkpoint_too_large"
  | "runtime_duplicate_node_output"
  | "runtime_invalid_json"
  | "runtime_node_attempt_invalid"
  | "runtime_node_output_error_envelope"
  | "runtime_node_output_status_invalid"
  | "runtime_node_status_transition_invalid"
  | "runtime_retry_not_permitted"
  | "runtime_state_invalid"
  | "runtime_state_public_payload"
  | "runtime_state_ref_payload";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: RuntimeErrorCode,
    options: {
      cause?: unknown;
      details?: Record<string, unknown>;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "RuntimeError";
    this.code = code;
    this.details = options.details;
  }
}

export function runtimeError(
  message: string,
  code: RuntimeErrorCode,
  options: {
    cause?: unknown;
    details?: Record<string, unknown>;
  } = {}
): RuntimeError {
  return new RuntimeError(message, code, options);
}
