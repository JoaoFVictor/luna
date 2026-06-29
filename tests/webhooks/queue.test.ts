import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookConfig } from "../../src/webhooks/config.js";
import type { WebhookInvocationJob } from "../../src/webhooks/contracts.js";
import {
  WEBHOOK_JOB_NAME,
  checkWebhookQueueReady,
  createWebhookQueue,
  createWebhookQueueEvents,
  enqueueWebhookInvocation,
  webhookJobId
} from "../../src/webhooks/queue.js";

const bullmqMock = vi.hoisted(() => ({
  Queue: vi.fn(function Queue(this: object) {
    return this;
  }),
  QueueEvents: vi.fn(function QueueEvents(this: object) {
    return this;
  })
}));

vi.mock("bullmq", () => bullmqMock);

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
    }
  }
};

const validJob: WebhookInvocationJob = {
  version: "2026-06",
  provider: "github",
  deliveryId: "delivery-1",
  receivedAt: "2026-06-28T12:00:00.000Z",
  invocation: {
    version: "2026-06",
    source: "github",
    event: "pull_request",
    action: "opened",
    target: {
      type: "workflow",
      id: "review"
    }
  }
};

type AddCall = {
  name: string;
  data: WebhookInvocationJob;
  opts: unknown;
};

function createFakeQueue() {
  const calls: AddCall[] = [];

  return {
    calls,
    queue: {
      async add(name: string, data: WebhookInvocationJob, opts?: unknown) {
        calls.push({ name, data, opts });
        return {};
      }
    }
  };
}

describe("webhook queue", () => {
  beforeEach(() => {
    bullmqMock.Queue.mockClear();
    bullmqMock.QueueEvents.mockClear();
  });

  it("builds a stable job id without colons", () => {
    const first = webhookJobId("github", "delivery:1");
    const second = webhookJobId("github", "delivery:1");

    expect(first).toBe(second);
    expect(first).toMatch(/^webhook-github-[a-f0-9]{64}$/);
    expect(first).not.toContain(":");
  });

  it("builds different job ids for different delivery ids", () => {
    expect(webhookJobId("github", "delivery-1")).not.toBe(
      webhookJobId("github", "delivery-2")
    );
  });

  it("uses the same BullMQ job id for duplicate deliveries", async () => {
    const fake = createFakeQueue();

    await enqueueWebhookInvocation(fake.queue, config, validJob);
    await enqueueWebhookInvocation(fake.queue, config, validJob);

    expect(fake.calls[0]?.opts).toMatchObject({
      jobId: webhookJobId("github", "delivery-1")
    });
    expect(fake.calls[1]?.opts).toMatchObject({
      jobId: webhookJobId("github", "delivery-1")
    });
  });

  it("adds webhook invocation jobs with the BullMQ job name", async () => {
    const fake = createFakeQueue();

    const result = await enqueueWebhookInvocation(fake.queue, config, validJob);

    expect(result).toEqual({ jobId: webhookJobId("github", "delivery-1") });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      name: WEBHOOK_JOB_NAME,
      data: validJob
    });
  });

  it("rejects invalid invocations before enqueue", async () => {
    const fake = createFakeQueue();
    const invalidJob = {
      ...validJob,
      invocation: {
        version: "2026-06",
        source: "github"
      }
    };

    await expect(
      enqueueWebhookInvocation(fake.queue, config, invalidJob)
    ).rejects.toMatchObject({
      code: "webhook_job_invalid"
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("retains completed jobs through the configured removeOnComplete age", async () => {
    const fake = createFakeQueue();

    await enqueueWebhookInvocation(fake.queue, config, validJob);

    expect(fake.calls[0]?.opts).toMatchObject({
      removeOnComplete: {
        age: config.queue.remove_on_complete.age_seconds,
        count: config.queue.remove_on_complete.count
      }
    });
  });

  it("passes BullMQ retry and removal options through", async () => {
    const fake = createFakeQueue();

    await enqueueWebhookInvocation(fake.queue, config, validJob);

    expect(fake.calls[0]?.opts).toMatchObject({
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 1000
      },
      removeOnComplete: {
        age: config.queue.remove_on_complete.age_seconds,
        count: config.queue.remove_on_complete.count
      },
      removeOnFail: config.queue.remove_on_fail
    });
  });

  it("wraps enqueue failures as queue unavailable errors", async () => {
    const cause = new Error("redis unavailable");
    const queue = {
      async add() {
        throw cause;
      }
    };

    await expect(
      enqueueWebhookInvocation(queue, config, validJob)
    ).rejects.toMatchObject({
      code: "webhook_queue_unavailable",
      statusCode: 503,
      cause
    });
  });

  it("checks readiness with waitUntilReady", async () => {
    const waitUntilReady = vi.fn(async () => undefined);

    await expect(
      checkWebhookQueueReady({ waitUntilReady })
    ).resolves.toBeUndefined();

    expect(waitUntilReady).toHaveBeenCalledOnce();
  });

  it("checks readiness with ping", async () => {
    const ping = vi.fn(async () => undefined);

    await expect(checkWebhookQueueReady({ ping })).resolves.toBeUndefined();

    expect(ping).toHaveBeenCalledOnce();
  });

  it("wraps readiness failures as queue unavailable errors", async () => {
    const cause = new Error("redis unavailable");

    await expect(
      checkWebhookQueueReady({
        waitUntilReady: async () => {
          throw cause;
        }
      })
    ).rejects.toMatchObject({
      code: "webhook_queue_unavailable",
      cause
    });
  });

  it("rejects readiness targets without waitUntilReady or ping", async () => {
    await expect(checkWebhookQueueReady({})).rejects.toMatchObject({
      code: "webhook_queue_unavailable"
    });
  });

  it("creates webhook queue with REDIS_URL env override", () => {
    createWebhookQueue(config, {
      REDIS_URL: "redis://override.example:6379"
    });

    expect(bullmqMock.Queue).toHaveBeenCalledWith(config.queue.name, {
      connection: {
        url: "redis://override.example:6379"
      }
    });
  });

  it("creates webhook queue events with REDIS_URL env override", () => {
    createWebhookQueueEvents(config, {
      REDIS_URL: "redis://events.example:6379"
    });

    expect(bullmqMock.QueueEvents).toHaveBeenCalledWith(config.queue.name, {
      connection: {
        url: "redis://events.example:6379"
      }
    });
  });

  it("uses configured redis url when no env override is provided", () => {
    createWebhookQueue(config, {});
    createWebhookQueueEvents(config, {});

    expect(bullmqMock.Queue).toHaveBeenCalledWith(config.queue.name, {
      connection: {
        url: config.queue.redis_url
      }
    });
    expect(bullmqMock.QueueEvents).toHaveBeenCalledWith(config.queue.name, {
      connection: {
        url: config.queue.redis_url
      }
    });
  });

  it("matches BullMQ queue-name constructor constraints", async () => {
    const { Queue } = await vi.importActual<typeof import("bullmq")>("bullmq");
    const safeQueue = new Queue("luna-webhooks", {
      connection: { url: "redis://127.0.0.1:6379" }
    });

    try {
      expect(() => {
        new Queue("luna:webhooks", {
          connection: { url: "redis://127.0.0.1:6379" }
        });
      }).toThrow("Queue name cannot contain :");
    } finally {
      await safeQueue.close();
    }
  });
});
