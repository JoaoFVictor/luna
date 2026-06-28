import { UnrecoverableError, Worker, type Job } from "bullmq";
import type { RouterDefinition } from "../core/router/router-definition.js";
import { routeInvocation, RouterError } from "../core/router/router.js";
import type { TargetExecutor } from "../runtime/composition/target-executor.js";
import { loadWebhookConfig, type WebhookConfig } from "./config.js";
import type { WebhookInvocationJob } from "./contracts.js";
import {
  createWebhookQueueEvents,
  WEBHOOK_JOB_NAME,
  WebhookInvocationJobSchema,
  webhookRedisConnectionOptions,
  type WebhookQueueEnv
} from "./queue.js";

export type ProcessWebhookJobDeps = {
  projectRoot: string;
  configRoot: string;
  routing: RouterDefinition;
  targetExecutor: TargetExecutor;
  logger?: Pick<Console, "info" | "warn" | "error">;
};

export type CreateWebhookWorkerDeps = ProcessWebhookJobDeps & {
  config: WebhookConfig;
  env?: WebhookQueueEnv;
};

export type WebhookWorkerSignalTarget = {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off?(event: NodeJS.Signals, listener: () => void): unknown;
};

export type WebhookWorkerHandle = {
  close(): Promise<void>;
};

export type StartWebhookWorkerDeps = ProcessWebhookJobDeps & {
  config?: WebhookConfig;
  env?: WebhookQueueEnv;
  signalTarget?: WebhookWorkerSignalTarget;
};

type Closable = {
  close(): Promise<unknown>;
};

function unrecoverable(message: string, cause: unknown): UnrecoverableError {
  const error = new UnrecoverableError(message);
  if (cause !== undefined) {
    Object.defineProperty(error, "cause", {
      configurable: true,
      enumerable: false,
      value: cause
    });
  }

  return error;
}

function jobId(job: Pick<Job<WebhookInvocationJob>, "id">): string | undefined {
  return typeof job.id === "string" ? job.id : undefined;
}

function safeErrorMetadata(error: unknown): {
  name: string;
  code?: string;
} {
  const name = error instanceof Error && error.name !== ""
    ? error.name
    : "Error";
  const code = typeof error === "object"
    && error !== null
    && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;

  return {
    name,
    ...(code !== undefined && /^[A-Z0-9_]+$/.test(code) ? { code } : {})
  };
}

function logBackgroundError(
  deps: Pick<StartWebhookWorkerDeps, "logger">,
  queue: string,
  component: "worker" | "queue-events",
  error: unknown
): void {
  deps.logger?.error("Webhook worker background error", {
    queue,
    component,
    error: safeErrorMetadata(error)
  });
}

async function closeAll(resources: readonly Closable[]): Promise<void> {
  const results = await Promise.allSettled(
    resources.map(async (resource) => {
      await resource.close();
    })
  );
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );

  if (rejected !== undefined) {
    throw rejected.reason;
  }
}

export async function processWebhookInvocationJob(
  deps: ProcessWebhookJobDeps,
  job: Pick<Job<WebhookInvocationJob>, "id" | "name" | "data">
): Promise<void> {
  if (job.name !== WEBHOOK_JOB_NAME) {
    throw unrecoverable("Webhook invocation job name is invalid", undefined);
  }

  const parsed = WebhookInvocationJobSchema.safeParse(job.data);

  if (!parsed.success) {
    throw unrecoverable("Webhook invocation job payload is invalid", parsed.error);
  }

  const webhookJob = parsed.data;
  const metadata = {
    provider: webhookJob.provider,
    deliveryId: webhookJob.deliveryId,
    jobId: jobId(job)
  };

  let target;
  try {
    target = await routeInvocation(webhookJob.invocation, deps.routing);
  } catch (error) {
    if (error instanceof RouterError && error.code === "router_no_match") {
      throw unrecoverable("Webhook invocation did not match any route", error);
    }

    throw error;
  }

  deps.logger?.info("Webhook invocation job routed", {
    ...metadata,
    target
  });

  const exitCode = await deps.targetExecutor.execute({
    target,
    invocation: webhookJob.invocation
  });

  if (exitCode !== 0) {
    throw new Error(
      `Webhook target execution failed with exit code ${exitCode}`
    );
  }

  deps.logger?.info("Webhook invocation job completed", {
    ...metadata,
    target
  });
}

export function createWebhookWorker(
  deps: CreateWebhookWorkerDeps
): Worker<WebhookInvocationJob> {
  return new Worker<WebhookInvocationJob>(
    deps.config.queue.name,
    async (job) => {
      await processWebhookInvocationJob(deps, job);
    },
    {
      connection: webhookRedisConnectionOptions(
        deps.config,
        deps.env ?? process.env
      ),
      concurrency: deps.config.worker.concurrency
    }
  );
}

export async function startWebhookWorker(
  deps: StartWebhookWorkerDeps
): Promise<WebhookWorkerHandle> {
  const config = deps.config ?? await loadWebhookConfig(deps.configRoot);
  const env = deps.env ?? process.env;
  const worker = createWebhookWorker({
    ...deps,
    config,
    env
  });
  const queueEvents = createWebhookQueueEvents(config, env);
  const signalTarget = deps.signalTarget ?? process;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  worker.on("error", (error: unknown) => {
    logBackgroundError(deps, config.queue.name, "worker", error);
  });
  queueEvents.on("error", (error: unknown) => {
    logBackgroundError(deps, config.queue.name, "queue-events", error);
  });

  const handle: WebhookWorkerHandle = {
    async close(): Promise<void> {
      if (closePromise !== undefined) {
        return await closePromise;
      }

      closePromise = (async () => {
        if (closed) {
          return;
        }
        closed = true;
        signalTarget.off?.("SIGINT", onSignal);
        signalTarget.off?.("SIGTERM", onSignal);
        await closeAll([worker, queueEvents]);
      })();

      return await closePromise;
    }
  };

  const onSignal = (): void => {
    void handle.close().catch((error: unknown) => {
      deps.logger?.error("Webhook worker shutdown failed", {
        queue: config.queue.name,
        error: safeErrorMetadata(error)
      });
    });
  };

  try {
    await worker.waitUntilReady();
    await queueEvents.waitUntilReady();
  } catch (error) {
    try {
      await closeAll([worker, queueEvents]);
    } catch (closeError) {
      deps.logger?.error("Webhook worker startup cleanup failed", {
        queue: config.queue.name,
        error: safeErrorMetadata(closeError)
      });
    }
    throw error;
  }

  signalTarget.on("SIGINT", onSignal);
  signalTarget.on("SIGTERM", onSignal);

  deps.logger?.info("Webhook worker started", {
    queue: config.queue.name,
    concurrency: config.worker.concurrency
  });

  return handle;
}
