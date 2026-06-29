import fastify, {
  type FastifyInstance,
  type FastifyRequest
} from "fastify";
import type { Queue } from "bullmq";
import { loadWebhookConfig, type WebhookConfig } from "./config.js";
import type {
  WebhookAdapterInput,
  WebhookInvocationJob,
  WebhookProviderAdapter,
  WebhookProviderAdapterFactory
} from "./contracts.js";
import {
  WebhookError,
  webhookPayloadInvalid,
  webhookQueueUnavailable
} from "./errors.js";
import {
  checkWebhookQueueReady,
  createWebhookQueue,
  enqueueWebhookInvocation,
  type WebhookQueueAddTarget
} from "./queue.js";
import {
  defineWebhookProviderAdapters,
  unknownWebhookProviderError,
  type WebhookProviderRegistry
} from "./provider-registry.js";
import { resolveProviderWebhookSecret } from "./secrets.js";
export type CreateWebhookServerDeps = {
  registry: WebhookProviderRegistry<WebhookProviderAdapter>;
  config: WebhookConfig;
  queue: WebhookQueueAddTarget;
  checkQueueReady: () => Promise<void>;
  logger?: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
};

export type BuildWebhookRuntimeProviderRegistryArgs = {
  config: WebhookConfig;
  projectRoot: string;
  webhookProviderRegistry: WebhookProviderRegistry<WebhookProviderAdapterFactory>;
};

export type StartWebhookServerListen = (
  app: FastifyInstance,
  options: { host: string; port: number }
) => Promise<void>;

export type WebhookServerHandle = {
  close(): Promise<void>;
};

export type StartWebhookServerDeps = {
  projectRoot?: string;
  configRoot?: string;
  config?: WebhookConfig;
  registry?: WebhookProviderRegistry<WebhookProviderAdapter>;
  webhookProviderRegistry?: WebhookProviderRegistry<WebhookProviderAdapterFactory>;
  queue?: Queue<WebhookInvocationJob>;
  createQueue?: (config: WebhookConfig) => Queue<WebhookInvocationJob>;
  checkQueueReady?: () => Promise<void>;
  listen?: StartWebhookServerListen;
  logger?: Pick<Console, "info" | "warn" | "error">;
};

type WebhookRouteParams = {
  provider: string;
};

type RawBodyRequest = FastifyRequest & {
  rawBody?: Buffer;
};

type WebhookResponseBody =
  | { status: "ok" }
  | {
      status: "ignored";
      provider: string;
      delivery_id?: string;
      reason: string;
    }
  | {
      status: "queued";
      provider: string;
      delivery_id: string;
      job_id: string;
    };

type ErrorResponseBody = {
  code: string;
  message: string;
};

type FrameworkHttpError = {
  statusCode?: unknown;
  status?: unknown;
};

function isJsonObject(body: unknown): body is Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body);
}

function errorResponse(error: unknown): {
  statusCode: number;
  body: ErrorResponseBody;
} {
  if (error instanceof WebhookError) {
    return {
      statusCode: error.statusCode ?? 500,
      body: {
        code: error.code,
        message: error.message
      }
    };
  }

  const frameworkStatusCode = frameworkErrorStatusCode(error);
  if (frameworkStatusCode !== undefined) {
    return {
      statusCode: frameworkStatusCode,
      body: {
        code: "webhook_payload_invalid",
        message:
          frameworkStatusCode === 413
            ? "Webhook payload exceeds the configured size limit"
            : "Webhook request is invalid"
      }
    };
  }

  return {
    statusCode: 500,
    body: {
      code: "webhook_internal_error",
      message: "Webhook request failed"
    }
  };
}

function frameworkErrorStatusCode(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") {
    return undefined;
  }

  const frameworkError = error as FrameworkHttpError;
  const statusCode =
    typeof frameworkError.statusCode === "number"
      ? frameworkError.statusCode
      : frameworkError.status;

  if (
    typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode < 500
  ) {
    return statusCode;
  }

  return undefined;
}

function parseJsonBody(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch (error) {
    throw webhookPayloadInvalid("Webhook payload is invalid JSON", error);
  }
}

function textField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function recordField(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = record[key];
  return isJsonObject(value) ? value : undefined;
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((label) => isJsonObject(label) ? textField(label, "name") : undefined)
    .filter((label): label is string => label !== undefined);
}

function webhookBodySummary(body: unknown): Record<string, unknown> {
  if (!isJsonObject(body)) {
    return { body_type: Array.isArray(body) ? "array" : typeof body };
  }

  const data = recordField(body, "data");
  const issue = recordField(body, "issue");
  const item = data ?? issue ?? body;
  const state = recordField(item, "state");
  const activity = recordField(body, "activity");

  return {
    event: textField(body, "event"),
    action: textField(body, "action"),
    activity_field: activity === undefined ? undefined : textField(activity, "field"),
    activity_new_value:
      activity === undefined ? undefined : textField(activity, "new_value"),
    state: state === undefined ? undefined : textField(state, "name"),
    labels: labelNames(item.labels)
  };
}

function isDisabledConfiguredProvider(
  config: WebhookConfig,
  provider: string
): boolean {
  return config.providers[provider]?.enabled === false;
}

export async function buildWebhookRuntimeProviderRegistry({
  config,
  projectRoot,
  webhookProviderRegistry
}: BuildWebhookRuntimeProviderRegistryArgs): Promise<
  WebhookProviderRegistry<WebhookProviderAdapter>
> {
  const adapters: WebhookProviderAdapter[] = [];

  for (const [provider, providerConfig] of Object.entries(config.providers)) {
    if (!providerConfig.enabled) {
      continue;
    }

    const factory = webhookProviderRegistry.require(provider);
    const secret = await resolveProviderWebhookSecret({
      projectRoot,
      secretRef: providerConfig.secret_ref
    });

    adapters.push(factory.create({ secret, config: providerConfig.config }));
  }

  return defineWebhookProviderAdapters(adapters);
}

async function loadNativeWebhookProviderRegistry(): Promise<
  WebhookProviderRegistry<WebhookProviderAdapterFactory>
> {
  const { nativeLunaPlatformRegistrations } = await import(
    "../platform/native/native-platform-registrations.js"
  );
  return nativeLunaPlatformRegistrations.webhookProviderRegistry;
}

async function defaultListen(
  app: FastifyInstance,
  options: { host: string; port: number }
): Promise<void> {
  await app.listen(options);
}

async function closeQueueAfterPrimaryFailure(
  queue: Pick<Queue<WebhookInvocationJob>, "close">,
  primaryError: unknown
): Promise<never> {
  try {
    await queue.close();
  } catch {
    // Preserve the original lifecycle failure; cleanup failures are secondary.
  }

  throw primaryError;
}

export function createWebhookServer(
  deps: CreateWebhookServerDeps
): FastifyInstance {
  const app = fastify({
    bodyLimit: deps.config.server.body_limit_bytes
  });
  const now = deps.now ?? (() => new Date());

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: deps.config.server.body_limit_bytes },
    (request, body, done) => {
      const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
      (request as RawBodyRequest).rawBody = rawBody;

      try {
        done(null, parseJsonBody(rawBody));
      } catch (error) {
        done(error as Error);
      }
    }
  );

  app.setErrorHandler((error, _request, reply) => {
    const mapped = errorResponse(error);
    reply.code(mapped.statusCode).send(mapped.body);
  });

  app.get("/healthz", async (): Promise<WebhookResponseBody> => {
    return { status: "ok" };
  });

  app.get(
    "/readyz",
    async (_request, reply): Promise<WebhookResponseBody | ErrorResponseBody> => {
      try {
        await deps.checkQueueReady();
        return { status: "ok" };
      } catch (error) {
        const mapped = errorResponse(webhookQueueUnavailable(
          "Webhook queue is unavailable",
          error
        ));
        reply.code(mapped.statusCode);
        return mapped.body;
      }
    }
  );

  app.post<{ Params: WebhookRouteParams }>(
    "/webhooks/:provider",
    async (request, reply): Promise<WebhookResponseBody | ErrorResponseBody> => {
      const provider = request.params.provider;

      if (!isJsonObject(request.body)) {
        const mapped = errorResponse(webhookPayloadInvalid());
        reply.code(mapped.statusCode);
        return mapped.body;
      }

      const adapter = deps.registry.get(provider);
      if (adapter === undefined) {
        if (isDisabledConfiguredProvider(deps.config, provider)) {
          return {
            status: "ignored",
            provider,
            reason: "provider_disabled"
          };
        }

        const mapped = errorResponse(unknownWebhookProviderError(provider, deps.registry));
        reply.code(mapped.statusCode);
        return mapped.body;
      }

      const rawBody = (request as RawBodyRequest).rawBody;
      if (rawBody === undefined) {
        const mapped = errorResponse(webhookPayloadInvalid());
        reply.code(mapped.statusCode);
        return mapped.body;
      }

      const input: WebhookAdapterInput = {
        provider,
        headers: request.headers,
        rawBody,
        body: request.body,
        receivedAt: now().toISOString()
      };
      deps.logger?.info("Webhook request received", {
        provider,
        content_type: request.headers["content-type"],
        user_agent: request.headers["user-agent"],
        delivery_id:
          request.headers["x-github-delivery"] ?? request.headers["x-plane-delivery"],
        event: request.headers["x-github-event"] ?? request.headers["x-plane-event"],
        has_signature:
          request.headers["x-hub-signature-256"] !== undefined ||
          request.headers["x-plane-signature"] !== undefined,
        body: webhookBodySummary(request.body)
      });

      try {
        await adapter.verify(input);
        const normalized = await adapter.normalize(input);

        if (normalized.kind === "ignored") {
          deps.logger?.info("Webhook request ignored", {
            provider,
            delivery_id: normalized.deliveryId,
            reason: normalized.reason
          });
          return {
            status: "ignored",
            provider,
            delivery_id: normalized.deliveryId,
            reason: normalized.reason
          };
        }

        const job: WebhookInvocationJob = {
          version: "2026-06",
          provider,
          deliveryId: normalized.deliveryId,
          receivedAt: input.receivedAt,
          invocation: normalized.invocation
        };
        const enqueued = await enqueueWebhookInvocation(
          deps.queue,
          deps.config,
          job
        );

        deps.logger?.info("Webhook request queued", {
          provider,
          delivery_id: normalized.deliveryId,
          job_id: enqueued.jobId
        });
        reply.code(202);
        return {
          status: "queued",
          provider,
          delivery_id: normalized.deliveryId,
          job_id: enqueued.jobId
        };
      } catch (error) {
        const mapped = errorResponse(error);
        deps.logger?.warn("Webhook request rejected", {
          provider,
          status_code: mapped.statusCode,
          code: mapped.body.code,
          message: mapped.body.message
        });
        reply.code(mapped.statusCode);
        return mapped.body;
      }
    }
  );

  return app;
}

export async function startWebhookServer({
  projectRoot = process.cwd(),
  configRoot = "config",
  config,
  registry,
  webhookProviderRegistry,
  queue,
  createQueue = createWebhookQueue,
  checkQueueReady: providedCheckQueueReady,
  listen = defaultListen,
  logger = console
}: StartWebhookServerDeps = {}): Promise<WebhookServerHandle> {
  const loadedConfig = config ?? await loadWebhookConfig(configRoot);
  const runtimeRegistry =
    registry ??
    await buildWebhookRuntimeProviderRegistry({
      config: loadedConfig,
      projectRoot,
      webhookProviderRegistry:
        webhookProviderRegistry ?? await loadNativeWebhookProviderRegistry()
    });
  const ownsQueue = queue === undefined;
  const webhookQueue = queue ?? createQueue(loadedConfig);
  const checkReady =
    providedCheckQueueReady ??
    (async () => {
      await checkWebhookQueueReady(webhookQueue);
    });
  const app = createWebhookServer({
    registry: runtimeRegistry,
    config: loadedConfig,
    queue: webhookQueue,
    checkQueueReady: checkReady,
    logger
  });

  try {
    await listen(app, {
      host: loadedConfig.server.host,
      port: loadedConfig.server.port
    });
  } catch (error) {
    if (ownsQueue) {
      await closeQueueAfterPrimaryFailure(webhookQueue, error);
    }
    throw error;
  }

  logger.info(
    `Webhook server listening on ${loadedConfig.server.host}:${loadedConfig.server.port}`
  );

  return {
    async close(): Promise<void> {
      try {
        await app.close();
      } catch (error) {
        if (ownsQueue) {
          await closeQueueAfterPrimaryFailure(webhookQueue, error);
        }
        throw error;
      }

      if (ownsQueue) {
        await webhookQueue.close();
      }
    }
  };
}
