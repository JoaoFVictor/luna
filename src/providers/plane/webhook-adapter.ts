import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { InvocationSchema } from "../../core/router/invocation.js";
import { repositoryHintFromLabels } from "../repository-hints/repository-reference.js";
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
    event: z.string().min(1).optional(),
    action: z.string().min(1),
    data: z
      .object({
        id: z.string().min(1),
        url: z.string().url().optional(),
        name: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        sequence_id: z.number().int().optional(),
        description: z.unknown().optional(),
        description_stripped: z.string().optional(),
        description_html: z.string().optional(),
        priority: z.string().optional(),
        state: z.unknown().optional(),
        labels: z.array(z.unknown()).optional(),
        project_id: z.string().min(1).optional(),
        project: z.string().min(1).optional(),
        workspace_detail: z
          .object({
            slug: z.string().min(1).optional(),
            id: z.string().min(1).optional()
          })
          .passthrough()
          .optional(),
        project_detail: z
          .object({
            slug: z.string().min(1).optional(),
            id: z.string().min(1).optional(),
            identifier: z.string().min(1).optional()
          })
          .passthrough()
          .optional()
      })
      .passthrough()
      .optional(),
    issue: z
      .object({
        id: z.string().min(1),
        url: z.string().url().optional(),
        name: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        sequence_id: z.number().int().optional(),
        description: z.unknown().optional(),
        description_stripped: z.string().optional(),
        description_html: z.string().optional(),
        priority: z.string().optional(),
        state: z.unknown().optional(),
        labels: z.array(z.unknown()).optional(),
        project_id: z.string().min(1).optional()
      })
      .passthrough()
      .optional(),
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

function textFromValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(textFromValue).filter(Boolean).join(" ");
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const ownText = typeof record.text === "string" ? record.text : "";
    const contentText = textFromValue(record.content);
    const combined = `${ownText}${contentText ? ` ${contentText}` : ""}`;

    return combined.trim();
  }

  return "";
}

function compactText(value: unknown): string {
  return textFromValue(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function nameOf(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string") {
      return record.name;
    }
  }

  return compactText(value);
}

function labelNames(values: unknown[] | undefined): string[] {
  if (values === undefined) {
    return [];
  }

  return values.map(nameOf).filter((label) => label.length > 0);
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
  const header = headerValue(input.headers, "x-plane-event");
  if (header !== undefined && header.trim() !== "") {
    return header;
  }

  const parsed = z
    .object({
      event: z.string().min(1)
    })
    .passthrough()
    .safeParse(input.body);
  if (parsed.success) {
    return parsed.data.event;
  }

  throw webhookPayloadInvalid("Plane webhook event is missing", parsed.error);
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
  const issue = issueFrom(payload);
  const labels = labelNames(issue.labels);
  const repositoryHint = repositoryHintFromLabels(labels);
  if (repositoryHint === undefined) {
    throw webhookPayloadInvalid("Plane issue webhook repository hint is missing");
  }

  const issueUrl = issue.url;
  if (issueUrl === undefined) {
    throw webhookPayloadInvalid("Plane issue webhook URL is missing");
  }

  const issueTitle = issue.name ?? issue.title;
  if (issueTitle === undefined) {
    throw webhookPayloadInvalid("Plane issue webhook title is missing");
  }

  const workspace = workspaceSlugOrId(payload);
  const project = projectSlugOrId(payload);
  const invocation = InvocationSchema.parse({
    version: "2026-06",
    source: "plane",
    event: "issue",
    action,
    repository: repositoryHint.repository,
    subject: {
      type: "plane_issue",
      id: issue.id,
      url: issueUrl,
      title: issueTitle
    },
    payload: {
      plane: {
        instance_id: workspace,
        workspace_slug: workspace,
        project_id: project,
        issue_id: issue.id,
        ...(issue.sequence_id === undefined ? {} : { sequence_id: issue.sequence_id }),
        description: compactText(
          issue.description_stripped ?? issue.description_html ?? issue.description
        ),
        status: nameOf(issue.state),
        priority: issue.priority ?? "",
        labels,
        repository_hint_source: repositoryHint.source
      },
      raw: payload
    }
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

function issueFrom(payload: PlaneIssuePayload): NonNullable<PlaneIssuePayload["data"]> {
  const issue = payload.data ?? payload.issue;
  if (issue === undefined) {
    throw webhookPayloadInvalid("Plane issue webhook payload is invalid");
  }

  return issue;
}

function workspaceSlugOrId(payload: PlaneIssuePayload): string {
  const value =
    payload.data?.workspace_detail?.slug ??
    payload.data?.workspace_detail?.id ??
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
    payload.data?.project_detail?.slug ??
    payload.data?.project_detail?.identifier ??
    payload.data?.project_detail?.id ??
    payload.data?.project_id ??
    payload.data?.project ??
    payload.project?.slug ??
    payload.project?.id ??
    payload.project_slug ??
    payload.project_id ??
    payload.issue?.project_id;
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
