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
import { nativeLunaPlatformRegistrations } from "../platform/native/native-platform-registrations.js";

export type CreateWebhookServerDeps = {
  registry: WebhookProviderRegistry<WebhookProviderAdapter>;
  config: WebhookConfig;
  queue: Pick<Queue<WebhookInvocationJob>, "add">;
  checkQueueReady: () => Promise<void>;
  logger?: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
};

export type BuildWebhookRuntimeProviderRegistryArgs = {
  config: WebhookConfig;
  projectRoot: string;
  webhookProviderRegistry?: WebhookProviderRegistry<WebhookProviderAdapterFactory>;
};

export type StartWebhookServerDeps = {
  projectRoot?: string;
  configRoot?: string;
  config?: WebhookConfig;
  registry?: WebhookProviderRegistry<WebhookProviderAdapter>;
  webhookProviderRegistry?: WebhookProviderRegistry<WebhookProviderAdapterFactory>;
  queue?: Queue<WebhookInvocationJob>;
  checkQueueReady?: () => Promise<void>;
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

  return {
    statusCode: 500,
    body: {
      code: "webhook_internal_error",
      message: "Webhook request failed"
    }
  };
}

function parseJsonBody(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch (error) {
    throw webhookPayloadInvalid("Webhook payload is invalid JSON", error);
  }
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
  webhookProviderRegistry = nativeLunaPlatformRegistrations.webhookProviderRegistry
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

    adapters.push(factory.create({ secret }));
  }

  return defineWebhookProviderAdapters(adapters);
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

      try {
        await adapter.verify(input);
        const normalized = await adapter.normalize(input);

        if (normalized.kind === "ignored") {
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
          deps.queue as WebhookQueueAddTarget,
          deps.config,
          job
        );

        reply.code(202);
        return {
          status: "queued",
          provider,
          delivery_id: normalized.deliveryId,
          job_id: enqueued.jobId
        };
      } catch (error) {
        const mapped = errorResponse(error);
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
  checkQueueReady: providedCheckQueueReady,
  logger = console
}: StartWebhookServerDeps = {}): Promise<void> {
  const loadedConfig = config ?? await loadWebhookConfig(configRoot);
  const runtimeRegistry =
    registry ??
    await buildWebhookRuntimeProviderRegistry({
      config: loadedConfig,
      projectRoot,
      ...(webhookProviderRegistry === undefined ? {} : { webhookProviderRegistry })
    });
  const webhookQueue = queue ?? createWebhookQueue(loadedConfig);
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

  await app.listen({
    host: loadedConfig.server.host,
    port: loadedConfig.server.port
  });
  logger.info(
    `Webhook server listening on ${loadedConfig.server.host}:${loadedConfig.server.port}`
  );
}
