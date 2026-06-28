import { createHash } from "node:crypto";
import { Queue, QueueEvents, type JobsOptions } from "bullmq";
import type { RedisOptions } from "ioredis";
import { z } from "zod";
import { InvocationSchema } from "../core/router/invocation.js";
import type { WebhookConfig } from "./config.js";
import type { WebhookInvocationJob } from "./contracts.js";
import {
  webhookJobInvalid,
  webhookQueueUnavailable
} from "./errors.js";

export const WEBHOOK_JOB_NAME = "run-webhook-invocation";

export const WebhookInvocationJobSchema = z
  .object({
    version: z.literal("2026-06"),
    provider: z.string().min(1),
    deliveryId: z.string().min(1),
    receivedAt: z.string().min(1),
    invocation: InvocationSchema
  })
  .strict();

export type WebhookQueueEnv = {
  REDIS_URL?: string;
};

export type WebhookQueueAddTarget = {
  add(
    name: typeof WEBHOOK_JOB_NAME,
    data: WebhookInvocationJob,
    opts: JobsOptions
  ): Promise<unknown>;
};

export type WebhookReadyTarget = {
  waitUntilReady?: () => Promise<unknown>;
  ping?: () => Promise<unknown>;
};

type RedisUrlConnectionOptions = Pick<RedisOptions, "lazyConnect"> & {
  url: string;
};

function redisConnectionOptions(
  config: WebhookConfig,
  env: WebhookQueueEnv
): RedisUrlConnectionOptions {
  return {
    url: env.REDIS_URL ?? config.queue.redis_url
  };
}

export function createWebhookQueue(
  config: WebhookConfig,
  env: WebhookQueueEnv = process.env
): Queue<WebhookInvocationJob> {
  return new Queue<WebhookInvocationJob>(config.queue.name, {
    connection: redisConnectionOptions(config, env)
  });
}

export function createWebhookQueueEvents(
  config: WebhookConfig,
  env: WebhookQueueEnv = process.env
): QueueEvents {
  return new QueueEvents(config.queue.name, {
    connection: redisConnectionOptions(config, env)
  });
}

export async function checkWebhookQueueReady(
  queueOrConnection: WebhookReadyTarget
): Promise<void> {
  try {
    if (typeof queueOrConnection.waitUntilReady === "function") {
      await queueOrConnection.waitUntilReady();
      return;
    }

    if (typeof queueOrConnection.ping === "function") {
      await queueOrConnection.ping();
      return;
    }
  } catch (error) {
    throw webhookQueueUnavailable("Webhook queue is unavailable", error);
  }

  throw webhookQueueUnavailable(
    "Webhook queue readiness target must expose waitUntilReady or ping"
  );
}

export function webhookJobId(provider: string, deliveryId: string): string {
  const deliveryHash = createHash("sha256").update(deliveryId).digest("hex");
  return `webhook-${provider.replace(/:/g, "-")}-${deliveryHash}`;
}

export async function enqueueWebhookInvocation(
  queue: WebhookQueueAddTarget,
  config: WebhookConfig,
  job: unknown
): Promise<{ jobId: string }> {
  const parsed = WebhookInvocationJobSchema.safeParse(job);

  if (!parsed.success) {
    throw webhookJobInvalid("Webhook job is invalid", parsed.error);
  }

  const jobId = webhookJobId(parsed.data.provider, parsed.data.deliveryId);
  const options: JobsOptions = {
    jobId,
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: {
      age: config.queue.remove_on_complete.age_seconds,
      count: config.queue.remove_on_complete.count
    },
    removeOnFail: config.queue.remove_on_fail
  };

  try {
    await queue.add(WEBHOOK_JOB_NAME, parsed.data, options);
  } catch (error) {
    throw webhookQueueUnavailable("Webhook queue is unavailable", error);
  }

  return { jobId };
}
