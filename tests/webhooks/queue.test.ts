import { describe, expect, it } from "vitest";
import type { WebhookConfig } from "../../src/webhooks/config.js";
import type { WebhookInvocationJob } from "../../src/webhooks/contracts.js";
import {
  WEBHOOK_JOB_NAME,
  enqueueWebhookInvocation,
  webhookJobId
} from "../../src/webhooks/queue.js";

const config: WebhookConfig = {
  version: "2026-06",
  server: {
    host: "127.0.0.1",
    port: 4012,
    body_limit_bytes: 1048576
  },
  queue: {
    name: "luna:webhooks",
    redis_url: "redis://127.0.0.1:6379",
    dedupe_ttl_seconds: 604800,
    remove_on_complete: {
      age_seconds: 604800,
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

  it("retains completed jobs through the configured dedupe window", async () => {
    const fake = createFakeQueue();

    await enqueueWebhookInvocation(fake.queue, config, validJob);

    expect(fake.calls[0]?.opts).toMatchObject({
      removeOnComplete: {
        age: config.queue.dedupe_ttl_seconds,
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
});
