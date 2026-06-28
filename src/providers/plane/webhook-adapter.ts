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

const PLANE_WEBHOOK_DESCRIPTION = "Plane webhook adapter";
const ACCEPTED_ISSUE_ACTIONS = new Set(["create", "update"]);

const PlaneIssuePayloadSchema = z
  .object({
    action: z.string().min(1),
    issue: z
      .object({
        id: z.string().min(1),
        url: z.string().url().optional(),
        name: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        project_id: z.string().min(1).optional()
      })
      .passthrough(),
    workspace: z
      .object({
        slug: z.string().min(1).optional(),
        id: z.string().min(1).optional()
      })
      .passthrough()
      .optional(),
    project: z
      .object({
        slug: z.string().min(1).optional(),
        id: z.string().min(1).optional()
      })
      .passthrough()
      .optional(),
    workspace_slug: z.string().min(1).optional(),
    workspace_id: z.string().min(1).optional(),
    project_slug: z.string().min(1).optional(),
    project_id: z.string().min(1).optional()
  })
  .passthrough();

type PlaneIssuePayload = z.infer<typeof PlaneIssuePayloadSchema>;

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
    "x-plane-delivery",
    "Plane webhook delivery id is missing"
  );
}

function planeEvent(input: WebhookAdapterInput): string {
  return requireHeader(input, "x-plane-event", "Plane webhook event is missing");
}

export function verifyPlaneWebhookSignature(
  input: WebhookAdapterInput,
  secret: string
): void {
  const signatureHeader = headerValue(input.headers, "x-plane-signature");
  if (signatureHeader === undefined || signatureHeader.trim() === "") {
    throw webhookSignatureMissing("Plane webhook signature is missing");
  }

  if (!/^[A-Fa-f0-9]+$/.test(signatureHeader) || signatureHeader.length % 2 !== 0) {
    throw webhookSignatureInvalid("Plane webhook signature is invalid");
  }

  const received = Buffer.from(signatureHeader, "hex");
  const expected = createHmac("sha256", secret).update(input.rawBody).digest();
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw webhookSignatureInvalid("Plane webhook signature is invalid");
  }
}

export function normalizePlaneWebhook(
  input: WebhookAdapterInput
): WebhookNormalizeResult {
  const id = deliveryId(input);
  const event = planeEvent(input);

  if (event !== "issue") {
    return { kind: "ignored", deliveryId: id, reason: "plane_event_ignored" };
  }

  const action = issueAction(input.body);
  if (action === "delete") {
    return { kind: "ignored", deliveryId: id, reason: "plane_issue_delete_ignored" };
  }

  if (!ACCEPTED_ISSUE_ACTIONS.has(action)) {
    return { kind: "ignored", deliveryId: id, reason: "plane_issue_action_ignored" };
  }

  const payload = parseIssuePayload(input.body);
  const invocation = InvocationSchema.parse({
    version: "2026-06",
    source: "plane",
    event: "issue",
    action,
    repository: {
      provider: "plane",
      owner: workspaceSlugOrId(payload),
      name: projectSlugOrId(payload)
    },
    subject: {
      type: "issue",
      id: payload.issue.id,
      ...(payload.issue.url === undefined ? {} : { url: payload.issue.url }),
      ...((payload.issue.name ?? payload.issue.title) === undefined
        ? {}
        : { title: payload.issue.name ?? payload.issue.title })
    },
    payload
  });

  return { kind: "accepted", deliveryId: id, invocation };
}

function issueAction(body: unknown): string {
  const parsed = z
    .object({
      action: z.string().min(1)
    })
    .passthrough()
    .safeParse(body);

  if (!parsed.success) {
    throw webhookPayloadInvalid("Plane issue webhook payload is invalid", parsed.error);
  }

  return parsed.data.action;
}

function parseIssuePayload(body: unknown): PlaneIssuePayload {
  const parsed = PlaneIssuePayloadSchema.safeParse(body);
  if (!parsed.success) {
    throw webhookPayloadInvalid("Plane issue webhook payload is invalid", parsed.error);
  }

  return parsed.data;
}

function workspaceSlugOrId(payload: PlaneIssuePayload): string {
  const value =
    payload.workspace?.slug ??
    payload.workspace?.id ??
    payload.workspace_slug ??
    payload.workspace_id;
  if (value === undefined) {
    throw webhookPayloadInvalid("Plane issue webhook workspace is missing");
  }

  return value;
}

function projectSlugOrId(payload: PlaneIssuePayload): string {
  const value =
    payload.project?.slug ??
    payload.project?.id ??
    payload.project_slug ??
    payload.project_id ??
    payload.issue.project_id;
  if (value === undefined) {
    throw webhookPayloadInvalid("Plane issue webhook project is missing");
  }

  return value;
}

export function createPlaneWebhookAdapter(secret: string): WebhookProviderAdapter {
  return {
    id: "plane",
    description: PLANE_WEBHOOK_DESCRIPTION,
    verify(input) {
      verifyPlaneWebhookSignature(input, secret);
    },
    normalize(input) {
      return normalizePlaneWebhook(input);
    }
  };
}

export const planeWebhookAdapterFactory: WebhookProviderAdapterFactory = {
  id: "plane",
  description: PLANE_WEBHOOK_DESCRIPTION,
  create({ secret }) {
    return createPlaneWebhookAdapter(secret);
  }
};
