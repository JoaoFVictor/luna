import type { Invocation } from "../core/router/invocation.js";

export type WebhookProviderId = string;

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export type WebhookAdapterInput = {
  provider: string;
  headers: WebhookHeaders;
  rawBody: Buffer;
  body: unknown;
  receivedAt: string;
};

export type WebhookNormalizeResult =
  | { kind: "accepted"; invocation: Invocation; deliveryId: string }
  | { kind: "ignored"; deliveryId: string; reason: string };

export type WebhookProviderRegistration = {
  id: WebhookProviderId;
  description: string;
};

export type WebhookProviderAdapter = WebhookProviderRegistration & {
  verify(input: WebhookAdapterInput): Promise<void> | void;
  normalize(input: WebhookAdapterInput): Promise<WebhookNormalizeResult> | WebhookNormalizeResult;
};

export type WebhookProviderAdapterFactory = WebhookProviderRegistration & {
  create(args: { secret: string }): WebhookProviderAdapter;
};

export type WebhookInvocationJob = {
  version: "2026-06";
  provider: string;
  deliveryId: string;
  receivedAt: string;
  invocation: Invocation;
};
