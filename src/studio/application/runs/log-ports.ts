import type {
  RunLogListQuery,
  RunLogPage
} from "../../contracts/run-logs.js";

export const RUN_LOG_READER_ERROR_CODES = [
  "run_log_changed",
  "run_log_cursor_expired",
  "run_log_cursor_invalid",
  "run_log_cursor_tampered",
  "run_log_input_invalid",
  "run_log_io_failed",
  "run_log_line_too_large",
  "run_log_security_violation",
  "run_log_snapshot_too_large",
  "run_log_store_corrupt"
] as const;

export type RunLogReaderErrorCode =
  (typeof RUN_LOG_READER_ERROR_CODES)[number];

export class RunLogReaderError extends Error {
  readonly code: RunLogReaderErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: RunLogReaderErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean | null>> = {}
  ) {
    super(message);
    this.name = "RunLogReaderError";
    this.code = code;
    this.details = details;
  }
}

export interface RunLogReaderPort {
  list(query: RunLogListQuery): Promise<RunLogPage>;
}
