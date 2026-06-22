import { describe, expect, it } from "vitest";
import {
  configuredRetryPolicy,
  DEFAULT_READ_ONLY_AGENT_RETRY_POLICY,
  retryDecision,
  retryDelayMs
} from "../../src/core/retry/policy.js";

describe("retry policy", () => {
  it("applies exponential backoff with full jitter", () => {
    const delay = retryDelayMs(
      {
        ...DEFAULT_READ_ONLY_AGENT_RETRY_POLICY,
        initialDelayMs: 1000,
        maxDelayMs: 10_000,
        backoffMultiplier: 2,
        jitter: "full"
      },
      3,
      () => 0.5
    );

    expect(delay).toBe(2000);
  });

  it("does not retry non-retryable failures", () => {
    expect(
      retryDecision({
        policy: DEFAULT_READ_ONLY_AGENT_RETRY_POLICY,
        attempt: 1,
        errorCode: "unknown_failure"
      })
    ).toEqual({
      shouldRetry: false,
      delayMs: 0,
      reason: "non_retryable_error"
    });
  });

  it("turns disabled retry into a single-attempt policy", () => {
    expect(
      configuredRetryPolicy(DEFAULT_READ_ONLY_AGENT_RETRY_POLICY, {
        enabled: false,
        max_attempts: 5
      }).maxAttempts
    ).toBe(1);
  });
});
