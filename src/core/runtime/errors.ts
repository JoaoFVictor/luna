export type RuntimeErrorCode =
  | "runtime_backend_invalid"
  | "runtime_checkpoint_too_large"
  | "runtime_checkpoint_not_ref_only"
  | "runtime_checkpoint_schema_mismatch"
  | "runtime_checkpoint_write_acceptance_unknown"
  | "runtime_durability_recovery_required"
  | "runtime_duplicate_node_output"
  | "runtime_interrupt_not_found"
  | "runtime_interrupt_resume_in_progress"
  | "runtime_interrupt_status_invalid"
  | "interrupt_conflict"
  | "interrupt_stale"
  | "interrupt_expired"
  | "interrupt_unauthorized"
  | "interrupt_concurrent_merge_unsupported"
  | "runtime_invalid_json"
  | "runtime_node_attempt_invalid"
  | "runtime_node_output_error_envelope"
  | "runtime_node_output_schema_invalid"
  | "runtime_node_output_status_invalid"
  | "runtime_node_status_transition_invalid"
  | "runtime_retry_not_permitted"
  | "runtime_state_invalid"
  | "runtime_state_public_payload"
  | "runtime_state_ref_payload"
  | "runtime_unsupported_feature";

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

/**
 * Signals that durable state may be committed, or that a durable protocol has
 * started but is not yet complete. Callers must reconcile/retry; recording a
 * contradictory terminal failure is unsafe.
 */
export class RuntimeDurabilityRecoveryRequiredError extends RuntimeError {
  constructor(
    message: string,
    options: {
      cause?: unknown;
      details?: Record<string, unknown>;
    } = {},
    code: Extract<
      RuntimeErrorCode,
      | "runtime_durability_recovery_required"
      | "runtime_checkpoint_write_acceptance_unknown"
    > = "runtime_durability_recovery_required"
  ) {
    super(message, code, options);
    this.name = "RuntimeDurabilityRecoveryRequiredError";
  }
}

export function isRuntimeDurabilityRecoveryRequired(
  cause: unknown
): cause is RuntimeDurabilityRecoveryRequiredError {
  return cause instanceof RuntimeDurabilityRecoveryRequiredError;
}

/**
 * Finds durability uncertainty inside nested concurrent-task AggregateErrors.
 * A single uncertain branch prevents a terminal classification for the whole
 * batch, so callers must check this before selecting ordinary node failures.
 */
export function runtimeDurabilityRecoveryRequiredFrom(
  cause: unknown
): RuntimeDurabilityRecoveryRequiredError | undefined {
  const matches: RuntimeDurabilityRecoveryRequiredError[] = [];
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (
      (typeof candidate !== "object" || candidate === null) &&
      typeof candidate !== "function"
    ) {
      return;
    }
    if (seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    if (candidate instanceof RuntimeDurabilityRecoveryRequiredError) {
      matches.push(candidate);
    }
    if (candidate instanceof AggregateError) {
      for (const nested of candidate.errors) {
        visit(nested);
      }
    }
    if (candidate instanceof Error && candidate.cause !== undefined) {
      visit(candidate.cause);
    }
  };
  visit(cause);
  matches.sort((left, right) => {
    const leftKey = `${left.code}\u0000${left.message}`;
    const rightKey = `${right.code}\u0000${right.message}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return matches[0];
}

export function runtimeError(
  message: string,
  code: RuntimeErrorCode,
  options: {
    cause?: unknown;
    details?: Record<string, unknown>;
  } = {}
): RuntimeError {
  const ErrorCtor = RuntimeError;
  return new ErrorCtor(message, code, options);
}
