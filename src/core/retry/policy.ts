export type RetryErrorCode =
  | "transient_transport_failure"
  | "timeout"
  | "provider_unavailable"
  | "rate_limited"
  | "permanent_failure"
  | "unknown_failure";

export type RetryJitter = "none" | "full";

export type RetryPolicy = {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitter: RetryJitter;
  retryableErrorCodes: readonly RetryErrorCode[];
};

export type RetryPolicyConfig = {
  enabled?: boolean;
  max_attempts?: number;
  initial_delay_ms?: number;
  max_delay_ms?: number;
  backoff_multiplier?: number;
  jitter?: RetryJitter;
  retryable_error_codes?: readonly RetryErrorCode[];
};

export type RetryDecision =
  | {
      shouldRetry: true;
      delayMs: number;
      reason: "retryable_error";
    }
  | {
      shouldRetry: false;
      delayMs: 0;
      reason: "attempts_exhausted" | "non_retryable_error";
    };

export const DEFAULT_READ_ONLY_AGENT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 10_000,
  backoffMultiplier: 2,
  jitter: "full",
  retryableErrorCodes: [
    "transient_transport_failure",
    "timeout",
    "provider_unavailable",
    "rate_limited"
  ]
};

export const DEFAULT_WRITE_AGENT_RETRY_POLICY: RetryPolicy = {
  ...DEFAULT_READ_ONLY_AGENT_RETRY_POLICY,
  maxAttempts: 1
};

export function configuredRetryPolicy(
  basePolicy: RetryPolicy,
  config: RetryPolicyConfig | undefined
): RetryPolicy {
  if (config === undefined) {
    return basePolicy;
  }

  if (config.enabled === false) {
    return {
      ...basePolicy,
      maxAttempts: 1
    };
  }

  return {
    maxAttempts: config.max_attempts ?? basePolicy.maxAttempts,
    initialDelayMs: config.initial_delay_ms ?? basePolicy.initialDelayMs,
    maxDelayMs: config.max_delay_ms ?? basePolicy.maxDelayMs,
    backoffMultiplier:
      config.backoff_multiplier ?? basePolicy.backoffMultiplier,
    jitter: config.jitter ?? basePolicy.jitter,
    retryableErrorCodes:
      config.retryable_error_codes ?? basePolicy.retryableErrorCodes
  };
}

export function retryDelayMs(
  policy: RetryPolicy,
  attempt: number,
  random = Math.random
): number {
  const exponentialDelay =
    policy.initialDelayMs * policy.backoffMultiplier ** Math.max(attempt - 1, 0);
  const cappedDelay = Math.min(exponentialDelay, policy.maxDelayMs);

  return policy.jitter === "full"
    ? Math.floor(random() * cappedDelay)
    : cappedDelay;
}

export function retryDecision({
  policy,
  attempt,
  errorCode,
  random
}: {
  policy: RetryPolicy;
  attempt: number;
  errorCode: RetryErrorCode;
  random?: () => number;
}): RetryDecision {
  if (attempt >= policy.maxAttempts) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: "attempts_exhausted"
    };
  }

  if (!policy.retryableErrorCodes.includes(errorCode)) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: "non_retryable_error"
    };
  }

  return {
    shouldRetry: true,
    delayMs: retryDelayMs(policy, attempt, random),
    reason: "retryable_error"
  };
}
