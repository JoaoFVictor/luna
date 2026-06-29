import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InvocationSchema } from "../../../src/core/router/invocation.js";
import type { WebhookAdapterInput } from "../../../src/webhooks/contracts.js";
import {
  createGitHubWebhookAdapter,
  githubWebhookAdapterFactory,
  normalizeGitHubWebhook,
  verifyGitHubWebhookSignature
} from "../../../src/providers/github/webhook-adapter.js";

const receivedAt = "2026-06-28T12:00:00.000Z";

function signature(secret: string, rawBody: Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  return undefined;
}

function input(options: {
  event?: string;
  deliveryId?: string;
  rawBody?: Buffer;
  body?: unknown;
  signatureHeader?: string;
} = {}): WebhookAdapterInput {
  const {
    event = "pull_request",
    rawBody,
    body,
    signatureHeader
  } = options;
  const payload = body ?? pullRequestPayload("opened");
  const encoded = rawBody ?? Buffer.from(JSON.stringify(payload));
  const deliveryId = "deliveryId" in options ? options.deliveryId : "delivery-1";
  const resolvedSignature =
    "signatureHeader" in options
      ? signatureHeader
      : signature("secret", encoded);

  return {
    provider: "github",
    headers: {
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": resolvedSignature
    },
    rawBody: encoded,
    body: payload,
    receivedAt
  };
}

function pullRequestPayload(action: string) {
  return {
    action,
    repository: {
      name: "luna",
      owner: {
        login: "acme"
      }
    },
    pull_request: {
      number: 42,
      html_url: "https://github.com/acme/luna/pull/42",
      title: "Add webhook adapter",
      base: {
        ref: "main",
        sha: "base-sha",
        repo: {
          name: "luna",
          full_name: "acme/luna",
          owner: {
            login: "acme"
          },
          private: true
        }
      },
      head: {
        ref: "feature/webhook-server",
        sha: "head-sha",
        repo: {
          name: "luna",
          full_name: "contributor/luna",
          fork: true,
          owner: {
            login: "contributor"
          },
          private: false
        }
      },
      body: "real GitHub payloads include many extra keys",
      changed_files: 2
    }
  };
}

describe("GitHub webhook adapter signature verification", () => {
  it("accepts a valid HMAC signature", () => {
    const rawBody = Buffer.from(JSON.stringify({ ok: true }));

    expect(() =>
      verifyGitHubWebhookSignature(
        input({
          rawBody,
          body: { ok: true },
          signatureHeader: signature("secret", rawBody)
        }),
        "secret"
      )
    ).not.toThrow();
  });

  it("rejects a missing signature", () => {
    const error = captureError(() =>
      verifyGitHubWebhookSignature(
        input({ signatureHeader: undefined }),
        "secret"
      )
    );

    expect(error).toMatchObject({
      code: "webhook_signature_missing",
      statusCode: 401,
      message: "GitHub webhook signature is missing"
    });
  });

  it("rejects an invalid signature", () => {
    const error = captureError(() =>
      verifyGitHubWebhookSignature(
        input({ signatureHeader: "sha256=not-the-right-signature" }),
        "secret"
      )
    );

    expect(error).toMatchObject({
      code: "webhook_signature_invalid",
      statusCode: 401,
      message: "GitHub webhook signature is invalid"
    });
  });

  it("accepts the GitHub documentation signature vector", () => {
    const rawBody = Buffer.from("Hello, World!");

    expect(() =>
      verifyGitHubWebhookSignature(
        input({
          rawBody,
          body: "Hello, World!",
          signatureHeader:
            "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"
        }),
        "It's a Secret to Everybody"
      )
    ).not.toThrow();
  });
});

describe("GitHub webhook adapter normalization", () => {
  it("ignores ping events", () => {
    expect(
      normalizeGitHubWebhook(
        input({ event: "ping", body: { zen: "Approachable is better than simple." } })
      )
    ).toEqual({
      kind: "ignored",
      deliveryId: "delivery-1",
      reason: "github_ping"
    });
  });

  it("accepts pull_request.opened and produces a valid invocation", () => {
    const result = normalizeGitHubWebhook(input());

    expect(result).toMatchObject({
      kind: "accepted",
      deliveryId: "delivery-1",
      invocation: {
        version: "2026-06",
        source: "github",
        event: "pull_request",
        action: "opened",
        repository: {
          provider: "github",
          owner: "acme",
          name: "luna"
        },
        subject: {
          type: "pull_request",
          id: "42",
          url: "https://github.com/acme/luna/pull/42",
          title: "Add webhook adapter"
        },
        references: {
          base_ref: "main",
          base_sha: "base-sha",
          head_ref: "feature/webhook-server",
          head_sha: "head-sha"
        }
      }
    });

    if (result.kind !== "accepted") {
      throw new Error("Expected accepted result");
    }
    expect(InvocationSchema.parse(result.invocation)).toEqual(result.invocation);
    expect(result.invocation.payload).toEqual({
      pull_request: {
        number: 42
      },
      base_repository: {
        owner: "acme",
        name: "luna",
        full_name: "acme/luna"
      },
      head_repository: {
        owner: "contributor",
        name: "luna",
        full_name: "contributor/luna",
        fork: true
      }
    });
  });

  it("ignores unsupported pull request actions", () => {
    expect(
      normalizeGitHubWebhook(
        input({
          body: pullRequestPayload("closed")
        })
      )
    ).toEqual({
      kind: "ignored",
      deliveryId: "delivery-1",
      reason: "github_pull_request_action_ignored"
    });
  });

  it("rejects a missing delivery id as an invalid payload/header", () => {
    const error = captureError(() =>
      normalizeGitHubWebhook(input({ deliveryId: undefined }))
    );

    expect(error).toMatchObject({
      code: "webhook_payload_invalid",
      statusCode: 400,
      message: "GitHub webhook delivery id is missing"
    });
  });
});

describe("GitHub webhook adapter factory", () => {
  it("creates secret-bound adapters without reading secrets at import time", () => {
    const adapter = createGitHubWebhookAdapter("secret");

    expect(adapter).toMatchObject({
      id: "github",
      description: "GitHub webhook adapter"
    });
    expect(githubWebhookAdapterFactory.create({ secret: "secret" })).toMatchObject({
      id: "github",
      description: "GitHub webhook adapter"
    });
  });
});
