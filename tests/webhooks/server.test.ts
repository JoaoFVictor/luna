import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import type { WebhookConfig } from "../../src/webhooks/config.js";
import type {
  WebhookAdapterInput,
  WebhookInvocationJob,
  WebhookNormalizeResult,
  WebhookProviderAdapter,
  WebhookProviderAdapterFactory
} from "../../src/webhooks/contracts.js";
import { webhookSignatureInvalid } from "../../src/webhooks/errors.js";
import {
  defineWebhookProviderAdapterFactories,
  defineWebhookProviderAdapters
} from "../../src/webhooks/provider-registry.js";
import {
  buildWebhookRuntimeProviderRegistry,
  createWebhookServer,
  startWebhookServer
} from "../../src/webhooks/server.js";

const receivedAt = "2026-06-28T12:00:00.000Z";

const config: WebhookConfig = {
  version: "2026-06",
  server: {
    host: "127.0.0.1",
    port: 4012,
    body_limit_bytes: 1048576
  },
  queue: {
    name: "luna-webhooks",
    redis_url: "redis://127.0.0.1:6379",
    dedupe_ttl_seconds: 604800,
    remove_on_complete: {
      age_seconds: 86400,
      count: 1000
    },
    remove_on_fail: false
  },
  worker: {
    concurrency: 8
  },
  providers: {
    github: {
      enabled: true,
      secret_ref: "providers.webhooks.github.secret"
    },
    disabled: {
      enabled: false,
      secret_ref: "providers.webhooks.disabled.secret"
    }
  }
};

const invocation = {
  version: "2026-06" as const,
  source: "github",
  event: "pull_request",
  action: "opened",
  target: {
    type: "workflow" as const,
    id: "review"
  }
};

type QueueAddCall = {
  name: string;
  data: WebhookInvocationJob;
  opts: unknown;
};

function createQueue() {
  const calls: QueueAddCall[] = [];
  return {
    calls,
    queue: {
      async add(name: string, data: WebhookInvocationJob, opts: unknown) {
        calls.push({ name, data, opts });
        return { id: String(opts) };
      }
    }
  };
}

function createAdapter(
  normalizeResult: WebhookNormalizeResult = {
    kind: "accepted",
    deliveryId: "delivery-1",
    invocation
  }
): WebhookProviderAdapter {
  return {
    id: "github",
    description: "GitHub webhook adapter",
    verify: vi.fn(),
    normalize: vi.fn(() => normalizeResult)
  };
}

function createServer({
  adapter = createAdapter(),
  queue = createQueue(),
  checkQueueReady = vi.fn(async () => undefined),
  serverConfig = config
}: {
  adapter?: WebhookProviderAdapter;
  queue?: ReturnType<typeof createQueue>;
  checkQueueReady?: () => Promise<void>;
  serverConfig?: WebhookConfig;
} = {}) {
  const server = createWebhookServer({
    registry: defineWebhookProviderAdapters([adapter]),
    config: serverConfig,
    queue: queue.queue as Pick<Queue<WebhookInvocationJob>, "add">,
    checkQueueReady,
    now: () => new Date(receivedAt)
  });

  return { server, adapter, queue, checkQueueReady };
}

async function parseJson(response: { body: string }) {
  return JSON.parse(response.body) as unknown;
}

describe("webhook HTTP server", () => {
  it("returns health status", async () => {
    const { server } = createServer();

    const response = await server.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(await parseJson(response)).toEqual({ status: "ok" });
  });

  it("returns ready status when the queue readiness check succeeds", async () => {
    const checkQueueReady = vi.fn(async () => undefined);
    const { server } = createServer({ checkQueueReady });

    const response = await server.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(await parseJson(response)).toEqual({ status: "ok" });
    expect(checkQueueReady).toHaveBeenCalledOnce();
  });

  it("returns unavailable when the queue readiness check fails", async () => {
    const checkQueueReady = vi.fn(async () => {
      throw new Error("redis unavailable");
    });
    const { server } = createServer({ checkQueueReady });

    const response = await server.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(await parseJson(response)).toMatchObject({
      code: "webhook_queue_unavailable"
    });
  });

  it("returns not found for an unknown provider", async () => {
    const { server, queue } = createServer();

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/gitlab",
      headers: { "content-type": "application/json" },
      payload: "{}"
    });

    expect(response.statusCode).toBe(404);
    expect(await parseJson(response)).toMatchObject({
      code: "unknown_webhook_provider"
    });
    expect(queue.calls).toHaveLength(0);
  });

  it("ignores configured disabled providers without enqueueing", async () => {
    const { server, queue } = createServer();

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/disabled",
      headers: { "content-type": "application/json" },
      payload: "{}"
    });

    expect(response.statusCode).toBe(200);
    expect(await parseJson(response)).toMatchObject({
      status: "ignored",
      provider: "disabled"
    });
    expect(queue.calls).toHaveLength(0);
  });

  it("returns unauthorized when signature verification fails", async () => {
    const adapter = createAdapter();
    vi.mocked(adapter.verify).mockImplementation(() => {
      throw webhookSignatureInvalid();
    });
    const { server, queue } = createServer({ adapter });

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: "{}"
    });

    expect(response.statusCode).toBe(401);
    expect(await parseJson(response)).toMatchObject({
      code: "webhook_signature_invalid"
    });
    expect(queue.calls).toHaveLength(0);
  });

  it("returns bad request for non-object JSON payloads", async () => {
    const { server, queue } = createServer();

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: "[]"
    });

    expect(response.statusCode).toBe(400);
    expect(await parseJson(response)).toMatchObject({
      code: "webhook_payload_invalid"
    });
    expect(queue.calls).toHaveLength(0);
  });

  it("returns bad request for malformed JSON payloads", async () => {
    const { server, queue } = createServer();

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: "{"
    });

    expect(response.statusCode).toBe(400);
    expect(await parseJson(response)).toMatchObject({
      code: "webhook_payload_invalid"
    });
    expect(queue.calls).toHaveLength(0);
  });

  it("returns payload too large when the body limit rejects the request", async () => {
    const limitedConfig: WebhookConfig = {
      ...config,
      server: {
        ...config.server,
        body_limit_bytes: 8
      }
    };
    const { server, queue } = createServer({ serverConfig: limitedConfig });
    const uniquePayloadContent = "secret-payload-detail";

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ value: uniquePayloadContent })
    });
    const parsed = await parseJson(response);

    expect(response.statusCode).toBe(413);
    expect(parsed).toMatchObject({
      code: "webhook_payload_invalid"
    });
    expect(JSON.stringify(parsed)).not.toContain(uniquePayloadContent);
    expect(queue.calls).toHaveLength(0);
  });

  it("returns ignored status for ignored provider events without enqueueing", async () => {
    const adapter = createAdapter({
      kind: "ignored",
      deliveryId: "delivery-ignored",
      reason: "event_not_supported"
    });
    const { server, queue } = createServer({ adapter });

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: "{}"
    });

    expect(response.statusCode).toBe(200);
    expect(await parseJson(response)).toEqual({
      status: "ignored",
      provider: "github",
      delivery_id: "delivery-ignored",
      reason: "event_not_supported"
    });
    expect(queue.calls).toHaveLength(0);
  });

  it("returns accepted status and enqueues accepted events once", async () => {
    const { server, queue } = createServer();

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: "{}"
    });

    expect(response.statusCode).toBe(202);
    expect(await parseJson(response)).toMatchObject({
      status: "queued",
      provider: "github",
      delivery_id: "delivery-1"
    });
    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0]?.data).toEqual({
      version: "2026-06",
      provider: "github",
      deliveryId: "delivery-1",
      receivedAt,
      invocation
    });
  });

  it("returns success for duplicate retained deliveries", async () => {
    const { server } = createServer();

    const first = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: "{}"
    });
    const second = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: "{}"
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(await parseJson(second)).toMatchObject({
      status: "queued",
      delivery_id: "delivery-1"
    });
  });

  it("returns unavailable when enqueue fails", async () => {
    const queue = {
      calls: [],
      queue: {
        async add() {
          throw new Error("redis unavailable");
        }
      }
    };
    const { server } = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: "{}"
    });

    expect(response.statusCode).toBe(503);
    expect(await parseJson(response)).toMatchObject({
      code: "webhook_queue_unavailable"
    });
  });

  it("passes exact raw request body bytes to the provider adapter", async () => {
    const adapter = createAdapter();
    const { server } = createServer({ adapter });
    const rawPayload = '{"z":1,"nested":{"a":true}}';

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: rawPayload
    });

    expect(response.statusCode).toBe(202);
    const input = vi.mocked(adapter.verify).mock.calls[0]?.[0] as
      | WebhookAdapterInput
      | undefined;
    expect(input?.rawBody).toEqual(Buffer.from(rawPayload));
    expect(input?.body).toEqual({ z: 1, nested: { a: true } });
  });
});

describe("webhook runtime provider registry", () => {
  it("builds secret-bound adapters for enabled configured providers only", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "luna-webhook-server-"));
    const create = vi.fn(({ secret }: { secret: string }) => ({
      id: "github",
      description: "GitHub webhook adapter",
      verify: vi.fn(),
      normalize: vi.fn(),
      secretForTest: secret
    }));
    const factory: WebhookProviderAdapterFactory = {
      id: "github",
      description: "GitHub webhook adapter factory",
      create
    };

    try {
      await writeFile(
        join(projectRoot, "luna.auth.json"),
        JSON.stringify({
          providers: {
            webhooks: {
              github: { secret: "github-secret" },
              disabled: { secret: "disabled-secret" }
            }
          }
        }),
        "utf8"
      );

      const registry = await buildWebhookRuntimeProviderRegistry({
        config,
        projectRoot,
        webhookProviderRegistry: defineWebhookProviderAdapterFactories([factory])
      });

      expect(registry.ids()).toEqual(["github"]);
      expect(create).toHaveBeenCalledExactlyOnceWith({ secret: "github-secret" });
      expect(registry.require("github")).toMatchObject({
        id: "github",
        secretForTest: "github-secret"
      });
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

describe("webhook server lifecycle", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };

  it("returns a lifecycle handle that closes the Fastify app", async () => {
    const queue = {
      add: vi.fn(),
      close: vi.fn(async () => undefined)
    } as unknown as Queue<WebhookInvocationJob>;
    let closeSpy: ReturnType<typeof vi.spyOn> | undefined;

    const handle = await startWebhookServer({
      config,
      registry: defineWebhookProviderAdapters([createAdapter()]),
      queue,
      checkQueueReady: vi.fn(async () => undefined),
      logger,
      listen: async (app) => {
        closeSpy = vi.spyOn(app, "close");
      }
    });

    await handle.close();

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(queue.close).not.toHaveBeenCalled();
  });

  it("closes an owned queue when the lifecycle handle closes", async () => {
    const queue = {
      add: vi.fn(),
      close: vi.fn(async () => undefined)
    } as unknown as Queue<WebhookInvocationJob>;

    const handle = await startWebhookServer({
      config,
      registry: defineWebhookProviderAdapters([createAdapter()]),
      createQueue: () => queue,
      logger,
      listen: async () => undefined
    });

    await handle.close();

    expect(queue.close).toHaveBeenCalledOnce();
  });

  it("closes an owned queue when startup listen fails", async () => {
    const queue = {
      add: vi.fn(),
      close: vi.fn(async () => undefined)
    } as unknown as Queue<WebhookInvocationJob>;
    const startupError = new Error("port unavailable");

    await expect(startWebhookServer({
      config,
      registry: defineWebhookProviderAdapters([createAdapter()]),
      createQueue: () => queue,
      logger,
      listen: async () => {
        throw startupError;
      }
    })).rejects.toThrow(startupError);

    expect(queue.close).toHaveBeenCalledOnce();
  });

  it("does not close an injected queue when startup listen fails", async () => {
    const queue = {
      add: vi.fn(),
      close: vi.fn(async () => undefined)
    } as unknown as Queue<WebhookInvocationJob>;
    const startupError = new Error("port unavailable");

    await expect(startWebhookServer({
      config,
      registry: defineWebhookProviderAdapters([createAdapter()]),
      queue,
      logger,
      listen: async () => {
        throw startupError;
      }
    })).rejects.toThrow(startupError);

    expect(queue.close).not.toHaveBeenCalled();
  });
});
