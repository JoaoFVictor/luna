import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InvocationSchema } from "../../../src/core/router/invocation.js";
import {
  createPlaneWebhookAdapter,
  normalizePlaneWebhook,
  planeWebhookAdapterFactory,
  verifyPlaneWebhookSignature
} from "../../../src/providers/plane/webhook-adapter.js";
import type { WebhookAdapterInput } from "../../../src/webhooks/contracts.js";

const receivedAt = "2026-06-28T12:00:00.000Z";

function signature(secret: string, rawBody: Buffer): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  return undefined;
}

function issuePayload(action: string, overrides: Record<string, unknown> = {}) {
  return {
    action,
    issue: {
      id: "issue-1",
      url: "https://app.plane.so/acme/projects/proj/issues/issue-1",
      name: "Implement webhooks"
    },
    workspace: {
      slug: "acme"
    },
    project: {
      slug: "proj"
    },
    ...overrides
  };
}

function input(options: {
  event?: string;
  deliveryId?: string;
  rawBody?: Buffer;
  body?: unknown;
  signatureHeader?: string;
} = {}): WebhookAdapterInput {
  const { event = "issue", rawBody, body, signatureHeader } = options;
  const payload = body ?? issuePayload("create");
  const encoded = rawBody ?? Buffer.from(JSON.stringify(payload));
  const deliveryId = "deliveryId" in options ? options.deliveryId : "delivery-1";
  const resolvedSignature =
    "signatureHeader" in options
      ? signatureHeader
      : signature("plane-secret", encoded);

  return {
    provider: "plane",
    headers: {
      "X-Plane-Event": event,
      "X-Plane-Delivery": deliveryId,
      "X-Plane-Signature": resolvedSignature
    },
    rawBody: encoded,
    body: payload,
    receivedAt
  };
}

describe("Plane webhook adapter signature verification", () => {
  it("accepts a valid HMAC-SHA256 hex signature over the raw body", () => {
    const body = issuePayload("create");
    const rawBody = Buffer.from(JSON.stringify(body));

    expect(signature("plane-secret", rawBody)).toBe(
      "b809cffbd1343a6c27b475d9b6fa5cb0072630483059746b338c490af4ab1704"
    );
    expect(() =>
      verifyPlaneWebhookSignature(
        input({
          rawBody,
          body,
          signatureHeader:
            "b809cffbd1343a6c27b475d9b6fa5cb0072630483059746b338c490af4ab1704"
        }),
        "plane-secret"
      )
    ).not.toThrow();
  });

  it("rejects a missing signature", () => {
    const error = captureError(() =>
      verifyPlaneWebhookSignature(input({ signatureHeader: undefined }), "plane-secret")
    );

    expect(error).toMatchObject({
      code: "webhook_signature_missing",
      statusCode: 401,
      message: "Plane webhook signature is missing"
    });
  });

  it("rejects an invalid signature", () => {
    const error = captureError(() =>
      verifyPlaneWebhookSignature(
        input({
          signatureHeader:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }),
        "plane-secret"
      )
    );

    expect(error).toMatchObject({
      code: "webhook_signature_invalid",
      statusCode: 401,
      message: "Plane webhook signature is invalid"
    });
  });
});

describe("Plane webhook adapter normalization", () => {
  it("accepts issue create and produces a valid invocation", () => {
    const result = normalizePlaneWebhook(input());

    expect(result).toMatchObject({
      kind: "accepted",
      deliveryId: "delivery-1",
      invocation: {
        version: "2026-06",
        source: "plane",
        event: "issue",
        action: "create",
        repository: {
          provider: "plane",
          owner: "acme",
          name: "proj"
        },
        subject: {
          type: "issue",
          id: "issue-1",
          url: "https://app.plane.so/acme/projects/proj/issues/issue-1",
          title: "Implement webhooks"
        }
      }
    });

    if (result.kind !== "accepted") {
      throw new Error("Expected accepted result");
    }
    expect(InvocationSchema.parse(result.invocation)).toEqual(result.invocation);
    expect(result.invocation.payload).toEqual(issuePayload("create"));
  });

  it("accepts issue update", () => {
    expect(normalizePlaneWebhook(input({ body: issuePayload("update") }))).toMatchObject({
      kind: "accepted",
      deliveryId: "delivery-1",
      invocation: {
        action: "update",
        payload: issuePayload("update")
      }
    });
  });

  it("ignores issue delete", () => {
    expect(normalizePlaneWebhook(input({ body: issuePayload("delete") }))).toEqual({
      kind: "ignored",
      deliveryId: "delivery-1",
      reason: "plane_issue_delete_ignored"
    });
  });

  it("rejects a missing issue id", () => {
    const error = captureError(() =>
      normalizePlaneWebhook(
        input({
          body: issuePayload("create", {
            issue: {
              url: "https://app.plane.so/acme/projects/proj/issues/issue-1",
              name: "Implement webhooks"
            }
          })
        })
      )
    );

    expect(error).toMatchObject({
      code: "webhook_payload_invalid",
      statusCode: 400,
      message: "Plane issue webhook payload is invalid"
    });
  });
});

describe("Plane webhook adapter factory", () => {
  it("creates secret-bound adapters without reading secrets at import time", () => {
    expect(createPlaneWebhookAdapter("plane-secret")).toMatchObject({
      id: "plane",
      description: "Plane webhook adapter"
    });
    expect(planeWebhookAdapterFactory.create({ secret: "plane-secret" })).toMatchObject({
      id: "plane",
      description: "Plane webhook adapter"
    });
  });
});
