export type WebhookErrorCode =
  | "unknown_webhook_provider"
  | "duplicate_webhook_provider"
  | "webhook_signature_missing"
  | "webhook_signature_invalid"
  | "webhook_payload_invalid"
  | "webhook_event_ignored"
  | "webhook_queue_unavailable"
  | "webhook_config_invalid"
  | "webhook_job_invalid"
  | "webhook_worker_failed";

export type WebhookHttpStatusCode = 200 | 400 | 401 | 404 | 503;

export class WebhookError extends Error {
  readonly code: WebhookErrorCode;
  readonly statusCode?: WebhookHttpStatusCode;

  constructor(
    code: WebhookErrorCode,
    message: string,
    options: { cause?: unknown; statusCode?: WebhookHttpStatusCode } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "WebhookError";
    this.code = code;
    this.statusCode = options.statusCode;
  }
}

export function webhookError(
  code: WebhookErrorCode,
  message: string,
  options: { cause?: unknown; statusCode?: WebhookHttpStatusCode } = {}
): WebhookError {
  return new WebhookError(code, message, options);
}

export function unknownWebhookProvider(
  provider: string,
  cause?: unknown
): WebhookError {
  return webhookError(
    "unknown_webhook_provider",
    `Unknown webhook provider: ${provider}`,
    { cause, statusCode: 404 }
  );
}

export function duplicateWebhookProvider(
  provider: string,
  cause?: unknown
): WebhookError {
  return webhookError(
    "duplicate_webhook_provider",
    `Duplicate webhook provider id: ${provider}`,
    { cause }
  );
}

export function webhookSignatureMissing(
  message = "Webhook signature is missing",
  cause?: unknown
): WebhookError {
  return webhookError("webhook_signature_missing", message, {
    cause,
    statusCode: 401
  });
}

export function webhookSignatureInvalid(
  message = "Webhook signature is invalid",
  cause?: unknown
): WebhookError {
  return webhookError("webhook_signature_invalid", message, {
    cause,
    statusCode: 401
  });
}

export function webhookPayloadInvalid(
  message = "Webhook payload is invalid",
  cause?: unknown
): WebhookError {
  return webhookError("webhook_payload_invalid", message, {
    cause,
    statusCode: 400
  });
}

export function webhookEventIgnored(
  message = "Webhook event ignored",
  cause?: unknown
): WebhookError {
  return webhookError("webhook_event_ignored", message, {
    cause,
    statusCode: 200
  });
}

export function webhookQueueUnavailable(
  message = "Webhook queue is unavailable",
  cause?: unknown
): WebhookError {
  return webhookError("webhook_queue_unavailable", message, {
    cause,
    statusCode: 503
  });
}

export function webhookConfigInvalid(
  message = "Webhook config is invalid",
  cause?: unknown
): WebhookError {
  return webhookError("webhook_config_invalid", message, { cause });
}

export function webhookJobInvalid(
  message = "Webhook job is invalid",
  cause?: unknown
): WebhookError {
  return webhookError("webhook_job_invalid", message, { cause });
}

export function webhookWorkerFailed(
  message = "Webhook worker failed",
  cause?: unknown
): WebhookError {
  return webhookError("webhook_worker_failed", message, { cause });
}
