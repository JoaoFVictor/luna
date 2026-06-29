import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import { UnrecoverableError } from "bullmq";
import type { RouterDefinition } from "../../src/core/router/router-definition.js";
import type { TargetExecutor } from "../../src/runtime/composition/target-executor.js";
import type { WebhookConfig } from "../../src/webhooks/config.js";
import type { WebhookInvocationJob } from "../../src/webhooks/contracts.js";
import { WEBHOOK_JOB_NAME } from "../../src/webhooks/queue.js";
import {
  createWebhookWorker,
  processWebhookInvocationJob,
  startWebhookWorker
} from "../../src/webhooks/worker.js";

const bullmqMock = vi.hoisted(() => {
  class MockUnrecoverableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "UnrecoverableError";
    }
  }

  const workerClose = vi.fn(async () => undefined);
  const queueClose = vi.fn(async () => undefined);
  const queueEventsClose = vi.fn(async () => undefined);
  const workerWaitUntilReady = vi.fn(async () => undefined);
  const queueEventsWaitUntilReady = vi.fn(async () => undefined);
  const workerOn = vi.fn();
  const queueEventsOn = vi.fn();

  return {
    Worker: vi.fn(function Worker(this: object) {
      Object.assign(this, {
        close: workerClose,
        waitUntilReady: workerWaitUntilReady,
        on: workerOn
      });
      return this;
    }),
    Queue: vi.fn(function Queue(this: object) {
      Object.assign(this, {
        close: queueClose
      });
      return this;
    }),
    QueueEvents: vi.fn(function QueueEvents(this: object) {
      Object.assign(this, {
        close: queueEventsClose,
        waitUntilReady: queueEventsWaitUntilReady,
        on: queueEventsOn
      });
      return this;
    }),
    UnrecoverableError: MockUnrecoverableError,
    workerClose,
    queueClose,
    queueEventsClose,
    workerWaitUntilReady,
    queueEventsWaitUntilReady,
    workerOn,
    queueEventsOn
  };
});

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

const routing = {
  type: "router",
  version: "2026-06",
  rules: [
    {
      id: "github_pr_review",
      when: {
        expression:
          "$.invocation.source = 'github' and $.invocation.event = 'pull_request'"
      },
      target: "workflow:code-review"
    }
  ]
} satisfies RouterDefinition;

const invocation = {
  version: "2026-06" as const,
  source: "github",
  event: "pull_request",
  action: "opened"
};

const validJobData: WebhookInvocationJob = {
  version: "2026-06",
  provider: "github",
  deliveryId: "delivery-1",
  receivedAt: "2026-06-28T12:00:00.000Z",
  invocation
};

function createJob(data: unknown, id = "job-1", name = WEBHOOK_JOB_NAME) {
  return {
    id,
    name,
    data
  } as Job<WebhookInvocationJob>;
}

function createTargetExecutor(
  execute = vi.fn(async () => 0)
): TargetExecutor & { execute: typeof execute } {
  return { execute };
}

describe("webhook worker processing", () => {
  beforeEach(() => {
    bullmqMock.Worker.mockClear();
    bullmqMock.Queue.mockClear();
    bullmqMock.QueueEvents.mockClear();
    bullmqMock.workerClose.mockClear();
    bullmqMock.queueClose.mockClear();
    bullmqMock.queueEventsClose.mockClear();
    bullmqMock.workerWaitUntilReady.mockReset();
    bullmqMock.workerWaitUntilReady.mockResolvedValue(undefined);
    bullmqMock.queueEventsWaitUntilReady.mockReset();
    bullmqMock.queueEventsWaitUntilReady.mockResolvedValue(undefined);
    bullmqMock.workerOn.mockClear();
    bullmqMock.queueEventsOn.mockClear();
  });

  it("routes accepted invocations through deterministic routing", async () => {
    const targetExecutor = createTargetExecutor();

    await processWebhookInvocationJob(
      {
        projectRoot: "/repo",
        configRoot: "/repo/config",
        routing,
        targetExecutor
      },
      createJob(validJobData)
    );

    expect(targetExecutor.execute).toHaveBeenCalledExactlyOnceWith({
      target: { type: "workflow", id: "code-review" },
      invocation
    });
  });

  it("calls the target executor with the routed workflow target", async () => {
    const targetExecutor = createTargetExecutor();

    await processWebhookInvocationJob(
      {
        projectRoot: "/repo",
        configRoot: "/repo/config",
        routing,
        targetExecutor
      },
      createJob({
        ...validJobData,
        invocation: {
          ...invocation,
          source: "github"
        }
      })
    );

    expect(targetExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          type: "workflow",
          id: "code-review"
        }
      })
    );
  });

  it("throws unrecoverable errors when no route matches", async () => {
    await expect(
      processWebhookInvocationJob(
        {
          projectRoot: "/repo",
          configRoot: "/repo/config",
          routing,
          targetExecutor: createTargetExecutor()
        },
        createJob({
          ...validJobData,
          invocation: {
            ...invocation,
            source: "plane"
          }
        })
      )
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("throws unrecoverable errors when job data is invalid", async () => {
    await expect(
      processWebhookInvocationJob(
        {
          projectRoot: "/repo",
          configRoot: "/repo/config",
          routing,
          targetExecutor: createTargetExecutor()
        },
        createJob({
          ...validJobData,
          invocation: {
            version: "2026-06",
            source: "github"
          }
        })
      )
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("throws unrecoverable errors for unexpected BullMQ job names", async () => {
    const targetExecutor = createTargetExecutor();

    await expect(
      processWebhookInvocationJob(
        {
          projectRoot: "/repo",
          configRoot: "/repo/config",
          routing,
          targetExecutor
        },
        createJob(validJobData, "job-1", "unexpected-job")
      )
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(targetExecutor.execute).not.toHaveBeenCalled();
  });

  it("throws retryable errors when the target executor returns non-zero", async () => {
    await expect(
      processWebhookInvocationJob(
        {
          projectRoot: "/repo",
          configRoot: "/repo/config",
          routing,
          targetExecutor: createTargetExecutor(vi.fn(async () => 2))
        },
        createJob(validJobData)
      )
    ).rejects.toThrow("Webhook target execution failed with exit code 2");
  });

  it("throws unrecoverable errors for permanent target execution failures", async () => {
    const error = Object.assign(new Error("Invalid GitHub pull request context"), {
      code: "github_pull_request_context_invalid"
    });

    await expect(
      processWebhookInvocationJob(
        {
          projectRoot: "/repo",
          configRoot: "/repo/config",
          routing,
          targetExecutor: createTargetExecutor(vi.fn(async () => {
            throw error;
          }))
        },
        createJob(validJobData)
      )
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("keeps unknown target execution failures retryable", async () => {
    await expect(
      processWebhookInvocationJob(
        {
          projectRoot: "/repo",
          configRoot: "/repo/config",
          routing,
          targetExecutor: createTargetExecutor(vi.fn(async () => {
            throw new Error("network hiccup");
          }))
        },
        createJob(validJobData)
      )
    ).rejects.toThrow("network hiccup");
  });

  it("uses worker concurrency default from parsed config", () => {
    createWebhookWorker({
      projectRoot: "/repo",
      configRoot: "/repo/config",
      config,
      routing,
      targetExecutor: createTargetExecutor(),
      env: {}
    });

    expect(bullmqMock.Worker).toHaveBeenCalledWith(
      config.queue.name,
      expect.any(Function),
      expect.objectContaining({
        concurrency: 8
      })
    );
  });

  it("allows configured worker concurrency", () => {
    createWebhookWorker({
      projectRoot: "/repo",
      configRoot: "/repo/config",
      config: {
        ...config,
        worker: { concurrency: 16 }
      },
      routing,
      targetExecutor: createTargetExecutor(),
      env: {}
    });

    expect(bullmqMock.Worker).toHaveBeenCalledWith(
      config.queue.name,
      expect.any(Function),
      expect.objectContaining({
        concurrency: 16
      })
    );
  });

  it("does not report the worker as started until BullMQ resources are ready", async () => {
    let resolveWorkerReady: (() => void) | undefined;
    bullmqMock.workerWaitUntilReady.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        resolveWorkerReady = () => resolve(undefined);
      })
    );
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const started = startWebhookWorker({
      projectRoot: "/repo",
      configRoot: "/repo/config",
      config,
      routing,
      targetExecutor: createTargetExecutor(),
      logger,
      env: {}
    });

    await Promise.resolve();

    expect(logger.info).not.toHaveBeenCalledWith(
      "Webhook worker started",
      expect.anything()
    );

    resolveWorkerReady?.();
    const handle = await started;
    await handle.close();

    expect(bullmqMock.workerWaitUntilReady).toHaveBeenCalledOnce();
    expect(bullmqMock.queueEventsWaitUntilReady).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith("Webhook worker started", {
      queue: config.queue.name,
      concurrency: config.worker.concurrency
    });
  });

  it("closes owned BullMQ resources and rethrows the startup error when readiness fails", async () => {
    const startupError = new Error("redis unavailable");
    bullmqMock.workerWaitUntilReady.mockRejectedValueOnce(startupError);

    await expect(
      startWebhookWorker({
        projectRoot: "/repo",
        configRoot: "/repo/config",
        config,
        routing,
        targetExecutor: createTargetExecutor(),
        env: {}
      })
    ).rejects.toBe(startupError);

    expect(bullmqMock.workerClose).toHaveBeenCalledOnce();
    expect(bullmqMock.queueEventsClose).toHaveBeenCalledOnce();
  });

  it("logs Worker and QueueEvents background errors with safe metadata", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const handle = await startWebhookWorker({
      projectRoot: "/repo",
      configRoot: "/repo/config",
      config,
      routing,
      targetExecutor: createTargetExecutor(),
      logger,
      env: {}
    });

    const workerErrorHandler = bullmqMock.workerOn.mock.calls.find(
      ([event]) => event === "error"
    )?.[1] as ((error: unknown) => void) | undefined;
    const queueEventsErrorHandler = bullmqMock.queueEventsOn.mock.calls.find(
      ([event]) => event === "error"
    )?.[1] as ((error: unknown) => void) | undefined;

    workerErrorHandler?.(Object.assign(new Error("password=secret"), {
      code: "ECONNREFUSED"
    }));
    queueEventsErrorHandler?.(new Error("raw-body-secret"));

    expect(() => workerErrorHandler?.(null)).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      "Webhook worker background error",
      {
        queue: config.queue.name,
        component: "worker",
        error: {
          name: "Error",
          code: "ECONNREFUSED"
        }
      }
    );
    expect(logger.error).toHaveBeenCalledWith(
      "Webhook worker background error",
      {
        queue: config.queue.name,
        component: "queue-events",
        error: {
          name: "Error"
        }
      }
    );
    expect(logger.error).toHaveBeenCalledWith(
      "Webhook worker background error",
      {
        queue: config.queue.name,
        component: "worker",
        error: {
          name: "Error"
        }
      }
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret");

    await handle.close();
  });

  it("logs signal shutdown close failures with safe metadata", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const signalListeners = new Map<NodeJS.Signals, () => void>();
    const signalTarget = {
      on: vi.fn((event: NodeJS.Signals, listener: () => void) => {
        signalListeners.set(event, listener);
      }),
      off: vi.fn()
    };
    const closeError = Object.assign(
      new Error("redis://default:secret-token@127.0.0.1:6379 close failed"),
      { code: "ECONNREFUSED" }
    );
    bullmqMock.workerClose.mockRejectedValueOnce(closeError);

    await startWebhookWorker({
      projectRoot: "/repo",
      configRoot: "/repo/config",
      config,
      routing,
      targetExecutor: createTargetExecutor(),
      logger,
      signalTarget,
      env: {}
    });

    signalListeners.get("SIGTERM")?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.error).toHaveBeenCalledWith(
      "Webhook worker shutdown failed",
      {
        queue: config.queue.name,
        error: {
          name: "Error",
          code: "ECONNREFUSED"
        }
      }
    );
    const shutdownLog = logger.error.mock.calls.find(
      ([message]) => message === "Webhook worker shutdown failed"
    );
    expect(shutdownLog?.[1]).not.toBe(closeError);
    expect(JSON.stringify(shutdownLog)).not.toContain("secret-token");
  });

  it("returns a lifecycle handle that closes worker lifecycle resources", async () => {
    const handle = await startWebhookWorker({
      projectRoot: "/repo",
      configRoot: "/repo/config",
      config,
      routing,
      targetExecutor: createTargetExecutor(),
      env: {}
    });

    await handle.close();

    expect(bullmqMock.workerClose).toHaveBeenCalledOnce();
    expect(bullmqMock.queueEventsClose).toHaveBeenCalledOnce();
  });

  it("matches BullMQ Worker queue-name constructor constraints without connecting to Redis", async () => {
    const { Worker } = await vi.importActual<typeof import("bullmq")>("bullmq");
    const safeWorker = new Worker(
      "luna-webhooks",
      async () => undefined,
      {
        autorun: false,
        connection: { url: "redis://127.0.0.1:6379" }
      }
    );

    try {
      expect(() => {
        new Worker(
          "luna:webhooks",
          async () => undefined,
          {
            autorun: false,
            connection: { url: "redis://127.0.0.1:6379" }
          }
        );
      }).toThrow("Queue name cannot contain :");
    } finally {
      await safeWorker.close();
    }
  });
});
