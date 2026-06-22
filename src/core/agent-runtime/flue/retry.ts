import {
  configuredRetryPolicy,
  DEFAULT_READ_ONLY_AGENT_RETRY_POLICY,
  DEFAULT_WRITE_AGENT_RETRY_POLICY,
  type RetryErrorCode,
  type RetryPolicy,
  type RetryPolicyConfig
} from "../../retry/policy.js";

function codedError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyFluePromptError(error: unknown): RetryErrorCode {
  const message = errorMessage(error);

  if (message.includes("ETIMEDOUT")) {
    return "timeout";
  }

  if (
    message.includes("WebSocket closed 1006") ||
    message.includes("ECONNRESET") ||
    message.includes("EPIPE")
  ) {
    return "transient_transport_failure";
  }

  if (message.includes("429") || /rate.?limit/i.test(message)) {
    return "rate_limited";
  }

  if (
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    /provider unavailable|service unavailable/i.test(message)
  ) {
    return "provider_unavailable";
  }

  return "unknown_failure";
}

export function fluePromptFailureHint(error: unknown): string | undefined {
  const message = errorMessage(error);

  if (message.includes("WebSocket closed 1006")) {
    return "WebSocket transport closed abnormally. For Codex/Pi model profiles, configure transport: sse to avoid replaying long prompts over an unstable WebSocket connection.";
  }

  return undefined;
}

export function readOnlyFluePromptRetryPolicy(
  config: RetryPolicyConfig | undefined
): RetryPolicy {
  return configuredRetryPolicy(DEFAULT_READ_ONLY_AGENT_RETRY_POLICY, config);
}

export function writeModeFluePromptRetryPolicy(
  config: RetryPolicyConfig | undefined
): RetryPolicy {
  if (config?.max_attempts !== undefined && config.max_attempts > 1) {
    throw codedError(
      [
        "Automatic retry was blocked for a trusted_host_local write agent.",
        "Write-mode prompts may have already changed files before a transport failure, so replaying the same prompt can duplicate or corrupt local edits.",
        "Set retry.max_attempts to 1 for this gated_agent_loop.",
        "Inspect the workspace diff/status before rerunning or recovering the workflow."
      ].join("\n"),
      "trusted_host_local_retry_unsafe"
    );
  }

  return configuredRetryPolicy(DEFAULT_WRITE_AGENT_RETRY_POLICY, config);
}
