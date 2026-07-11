export const RUN_STORE_ERROR_CODES = [
  "run_already_exists",
  "run_cursor_invalid",
  "run_cursor_expired",
  "run_cursor_tampered",
  "run_event_id_conflict",
  "run_event_sequence_conflict",
  "run_idempotency_conflict",
  "run_invalid_input",
  "run_not_found",
  "run_owner_conflict",
  "run_revision_conflict",
  "run_store_busy",
  "run_store_closed",
  "run_store_corrupt",
  "run_store_io_failed",
  "run_store_schema_unsupported",
  "run_terminal_immutable",
  "run_transition_invalid"
] as const;

export type RunStoreErrorCode = (typeof RUN_STORE_ERROR_CODES)[number];

export class RunStoreError extends Error {
  readonly code: RunStoreErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: RunStoreErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean | null>> = {}
  ) {
    super(message);
    this.name = "RunStoreError";
    this.code = code;
    this.details = details;
  }
}

export function runStoreError(
  code: RunStoreErrorCode,
  message: string,
  details: Readonly<Record<string, string | number | boolean | null>> = {}
): RunStoreError {
  return new RunStoreError(code, message, details);
}
