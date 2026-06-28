import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { InvocationSchema } from "../../core/router/invocation.js";
import type {
  WebhookAdapterInput,
  WebhookHeaders,
  WebhookNormalizeResult,
  WebhookProviderAdapter,
  WebhookProviderAdapterFactory
} from "../../webhooks/contracts.js";
import {
  webhookPayloadInvalid,
  webhookSignatureInvalid,
  webhookSignatureMissing
} from "../../webhooks/errors.js";

const GITHUB_WEBHOOK_DESCRIPTION = "GitHub webhook adapter";
const ACCEPTED_PULL_REQUEST_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

const GitHubPullRequestPayloadSchema = z
  .object({
    action: z.string().min(1),
    repository: z
      .object({
        name: z.string().min(1),
        owner: z
          .object({
            login: z.string().min(1)
          })
          .passthrough()
      })
      .passthrough(),
    pull_request: z
      .object({
        number: z.number().int().positive(),
        html_url: z.string().url(),
        title: z.string().min(1),
        base: z
          .object({
            ref: z.string().min(1),
            sha: z.string().min(1)
          })
          .passthrough(),
        head: z
          .object({
            ref: z.string().min(1),
            sha: z.string().min(1)
          })
          .passthrough()
      })
      .passthrough()
  })
  .passthrough();

function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  const lowerName = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) {
      continue;
    }

    if (Array.isArray(value)) {
      return value.length === 1 ? value[0] : undefined;
    }

    return value;
  }

  return undefined;
}

function requireHeader(
  input: WebhookAdapterInput,
  name: string,
  message: string
): string {
  const value = headerValue(input.headers, name);
  if (value === undefined || value.trim() === "") {
    throw webhookPayloadInvalid(message);
  }

  return value;
}

function deliveryId(input: WebhookAdapterInput): string {
  return requireHeader(
    input,
    "x-github-delivery",
    "GitHub webhook delivery id is missing"
  );
}

function githubEvent(input: WebhookAdapterInput): string {
  return requireHeader(input, "x-github-event", "GitHub webhook event is missing");
}

export function verifyGitHubWebhookSignature(
  input: WebhookAdapterInput,
  secret: string
): void {
  const signatureHeader = headerValue(input.headers, "x-hub-signature-256");
  if (signatureHeader === undefined || signatureHeader.trim() === "") {
    throw webhookSignatureMissing("GitHub webhook signature is missing");
  }

  const match = /^sha256=([A-Fa-f0-9]+)$/.exec(signatureHeader);
  if (match === null) {
    throw webhookSignatureInvalid("GitHub webhook signature is invalid");
  }

  const received = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(input.rawBody).digest();
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw webhookSignatureInvalid("GitHub webhook signature is invalid");
  }
}

export function normalizeGitHubWebhook(
  input: WebhookAdapterInput
): WebhookNormalizeResult {
  const id = deliveryId(input);
  const event = githubEvent(input);

  if (event === "ping") {
    return { kind: "ignored", deliveryId: id, reason: "github_ping" };
  }

  if (event !== "pull_request") {
    return { kind: "ignored", deliveryId: id, reason: "github_event_ignored" };
  }

  const action = pullRequestAction(input.body);
  if (!ACCEPTED_PULL_REQUEST_ACTIONS.has(action)) {
    return {
      kind: "ignored",
      deliveryId: id,
      reason: "github_pull_request_action_ignored"
    };
  }

  const payload = parsePullRequestPayload(input.body);
  const invocation = InvocationSchema.parse({
    version: "2026-06",
    source: "github",
    event: "pull_request",
    action,
    repository: {
      provider: "github",
      owner: payload.repository.owner.login,
      name: payload.repository.name
    },
    subject: {
      type: "pull_request",
      id: String(payload.pull_request.number),
      url: payload.pull_request.html_url,
      title: payload.pull_request.title
    },
    references: {
      base_ref: payload.pull_request.base.ref,
      base_sha: payload.pull_request.base.sha,
      head_ref: payload.pull_request.head.ref,
      head_sha: payload.pull_request.head.sha
    },
    payload
  });

  return { kind: "accepted", deliveryId: id, invocation };
}

function pullRequestAction(body: unknown): string {
  const parsed = z
    .object({
      action: z.string().min(1)
    })
    .passthrough()
    .safeParse(body);

  if (!parsed.success) {
    throw webhookPayloadInvalid("GitHub pull request webhook payload is invalid", parsed.error);
  }

  return parsed.data.action;
}

function parsePullRequestPayload(body: unknown): z.infer<
  typeof GitHubPullRequestPayloadSchema
> {
  const parsed = GitHubPullRequestPayloadSchema.safeParse(body);
  if (!parsed.success) {
    throw webhookPayloadInvalid("GitHub pull request webhook payload is invalid", parsed.error);
  }

  return parsed.data;
}

export function createGitHubWebhookAdapter(secret: string): WebhookProviderAdapter {
  return {
    id: "github",
    description: GITHUB_WEBHOOK_DESCRIPTION,
    verify(input) {
      verifyGitHubWebhookSignature(input, secret);
    },
    normalize(input) {
      return normalizeGitHubWebhook(input);
    }
  };
}

export const githubWebhookAdapterFactory: WebhookProviderAdapterFactory = {
  id: "github",
  description: GITHUB_WEBHOOK_DESCRIPTION,
  create({ secret }) {
    return createGitHubWebhookAdapter(secret);
  }
};
