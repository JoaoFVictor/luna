import { describe, expect, it } from "vitest";
import {
  WebhookError,
  webhookConfigInvalid,
  webhookPayloadInvalid,
  webhookQueueUnavailable,
  webhookSignatureInvalid,
  webhookSignatureMissing,
  unknownWebhookProvider
} from "../../src/webhooks/errors.js";

describe("webhook errors", () => {
  it("preserves error codes and HTTP status codes", () => {
    expect(unknownWebhookProvider("gitlab")).toMatchObject({
      code: "unknown_webhook_provider",
      statusCode: 404
    });
    expect(webhookSignatureMissing("Missing signature")).toMatchObject({
      code: "webhook_signature_missing",
      statusCode: 401
    });
    expect(webhookSignatureInvalid("Bad signature")).toMatchObject({
      code: "webhook_signature_invalid",
      statusCode: 401
    });
    expect(webhookPayloadInvalid("Invalid payload")).toMatchObject({
      code: "webhook_payload_invalid",
      statusCode: 400
    });
    expect(webhookQueueUnavailable("Queue down")).toMatchObject({
      code: "webhook_queue_unavailable",
      statusCode: 503
    });
  });

  it("preserves the original cause", () => {
    const cause = new Error("schema failed");
    const error = webhookConfigInvalid("Invalid webhook config", cause);

    expect(error).toBeInstanceOf(WebhookError);
    expect(error.cause).toBe(cause);
  });

  it("can be matched with toMatchObject", () => {
    expect(webhookConfigInvalid("Missing secret")).toMatchObject({
      code: "webhook_config_invalid",
      message: "Missing secret"
    });
  });
});
