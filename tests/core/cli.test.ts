import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { InputAdapterRegistry } from "../../src/adapters/registry.js";
import type {
  InputAdapter,
  RegisteredInputAdapter
} from "../../src/adapters/types.js";
import type { Invocation } from "../../src/core/router/invocation.js";
import { createInitialRuntimeState } from "../../src/core/runtime/state.js";
import type { WorkflowRunResult } from "../../src/core/workflow/execution-contracts.js";
import type { LunaPlatform } from "../../src/platform/native/native-platform.js";
import { defineWebhookProviderAdapterFactories } from "../../src/webhooks/provider-registry.js";
import {
  findProjectRoot,
  loadRoutingDefinition,
  main,
  parseCliArgs,
  resolveCliConfigRoot
} from "../../src/cli.js";

const validInvocation: Invocation = {
  version: "2026-06",
  source: "github",
  event: "pull_request",
  action: "selected",
  repository: {
    provider: "github",
    owner: "octo-org",
    name: "hello-world"
  },
  subject: {
    type: "pull_request",
    id: "42",
    url: "https://github.com/octo-org/hello-world/pull/42"
  },
  references: {
    base_ref: "main",
    base_sha: "abc123",
    head_sha: "def456"
  },
  payload: { pull_request: { number: 42 } }
};

function registryWith(
  adapter: InputAdapter,
  source = "test"
): InputAdapterRegistry<RegisteredInputAdapter> {
  const registered = { ...adapter, source };
  return {
    get(id) {
      return id === registered.id ? registered : undefined;
    },
    require(id) {
      if (id !== registered.id) {
        throw new Error(`Unexpected adapter id: ${id}`);
      }

      return registered;
    },
    ids() {
      return [registered.id];
    }
  };
}

function succeededWorkflowResult(): WorkflowRunResult {
  return {
    status: "succeeded",
    output: {},
    state: createInitialRuntimeState({
      invocation: {},
      config: {},
      run: {
        run_id: "test-run",
        workflow_id: "implementation",
        attempt: 1,
        started_at: "2026-06-28T00:00:00.000Z"
      },
      workflow: { id: "implementation", mode: "trusted_local_write" }
    })
  };
}

async function writeCliProjectConfig({
  projectRoot,
  configRoot,
  workerConcurrency = 8
}: {
  projectRoot: string;
  configRoot: string;
  workerConcurrency?: number;
}): Promise<void> {
  await mkdir(configRoot, { recursive: true });
  await writeFile(
    path.join(configRoot, "app.yaml"),
    [
      "workspace:",
      "  strategy: git_worktree",
      `  root: ${JSON.stringify(path.join(projectRoot, "workspaces"))}`,
      "  preserve_on_success: false",
      "  preserve_on_failure: true",
      "artifacts:",
      `  root: ${JSON.stringify(path.join(projectRoot, "artifacts"))}`,
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(configRoot, "routing.yaml"),
    [
      "type: router",
      "version: \"2026-06\"",
      "rules:",
      "  - id: cli_webhook_route",
      "    when:",
      "      expression: \"true\"",
      "    target: workflow:implementation",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(configRoot, "webhooks.yaml"),
    [
      "version: \"2026-06\"",
      "server:",
      "  host: 127.0.0.1",
      "  port: 3000",
      "  body_limit_bytes: 1048576",
      "queue:",
      "  name: luna-webhooks",
      "  redis_url: redis://localhost:6379",
      "  dedupe_ttl_seconds: 86400",
      "  remove_on_complete:",
      "    age_seconds: 3600",
      "    count: 1000",
      "  remove_on_fail: true",
      "worker:",
      `  concurrency: ${workerConcurrency}`,
      "providers: {}",
      ""
    ].join("\n")
  );
}

function webhookPlatform(): Pick<
  LunaPlatform,
  "inputAdapterRegistry" | "runWorkflow" | "resumeWorkflow"
> {
  return {
    inputAdapterRegistry: registryWith({
      id: "unused",
      description: "Unused",
      load: vi.fn()
    }),
    runWorkflow: vi.fn(async () => undefined),
    resumeWorkflow: vi.fn(async () => succeededWorkflowResult())
  };
}

describe("Luna CLI", () => {
  it("rejects invalid or workflow-specific command shapes", () => {
    expect(() => parseCliArgs(["run", "--workflow", "code-review"])).toThrow(
      expect.objectContaining({ code: "unsupported_flag" })
    );
    expect(() => parseCliArgs(["review-pr", "url"])).toThrow(
      expect.objectContaining({ code: "unknown_command" })
    );
  });

  it("parses generic workflow resume arguments", () => {
    expect(
      parseCliArgs([
        "resume",
        "--target",
        "workflow:implementation",
        "--thread",
        "run-1",
        "--checkpoint",
        "checkpoint-run-1-approval",
        "--interrupt",
        "interrupt-run-1-approval",
        "--decision",
        "{\"approved\":true}"
      ])
    ).toEqual({
      command: "resume",
      target: { type: "workflow", id: "implementation" },
      thread: "run-1",
      checkpoint: "checkpoint-run-1-approval",
      interrupt: "interrupt-run-1-approval",
      decision: { approved: true }
    });
  });

  it("parses generic webhook server arguments", () => {
    expect(
      parseCliArgs([
        "webhook-server",
        "--host",
        "0.0.0.0",
        "--port",
        "8080"
      ])
    ).toEqual({
      command: "webhook-server",
      host: "0.0.0.0",
      port: 8080
    });
  });

  it("parses the generic Studio server arguments", () => {
    expect(
      parseCliArgs([
        "studio",
        "--host",
        "127.0.0.1",
        "--port",
        "43111"
      ])
    ).toEqual({
      command: "studio",
      host: "127.0.0.1",
      port: 43_111
    });
  });

  it("parses generic webhook worker arguments", () => {
    expect(
      parseCliArgs([
        "webhook-worker",
        "--concurrency",
        "4"
      ])
    ).toEqual({
      command: "webhook-worker",
      concurrency: 4
    });
  });

  it("rejects unknown webhook flags", () => {
    expect(() => parseCliArgs(["webhook-server", "--config", "config"])).toThrow(
      expect.objectContaining({ code: "unsupported_flag" })
    );
    expect(() => parseCliArgs(["webhook-worker", "--port", "8080"])).toThrow(
      expect.objectContaining({ code: "unsupported_flag" })
    );
    expect(() => parseCliArgs(["studio", "--config", "config"])).toThrow(
      expect.objectContaining({ code: "unsupported_flag" })
    );
  });

  it("finds the project root from compiled dist paths", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-cli-root-"));
    const nestedStart = path.join(projectRoot, "dist", "src", "core");

    await mkdir(nestedStart, { recursive: true });
    await writeFile(path.join(projectRoot, "package.json"), "{}");

    await expect(findProjectRoot(nestedStart)).resolves.toBe(projectRoot);
  });

  it("loads routing from LUNA_CONFIG_ROOT outside projectRoot/config", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-cli-project-"));
    const configRoot = await mkdtemp(path.join(tmpdir(), "luna-cli-config-"));
    await mkdir(path.join(configRoot, "nested"));
    await writeFile(
      path.join(configRoot, "app.yaml"),
      [
        "workspace:",
        "  strategy: git_worktree",
        `  root: ${JSON.stringify(path.join(projectRoot, "workspaces"))}`,
        "  preserve_on_success: false",
        "  preserve_on_failure: true",
        "artifacts:",
        `  root: ${JSON.stringify(path.join(projectRoot, "artifacts"))}`,
        "routing:",
        "  path: ./nested//external-routing.yaml",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(configRoot, "nested", "external-routing.yaml"),
      [
        "type: router",
        "version: \"2026-06\"",
        "rules:",
        "  - id: external_config_root_route",
        "    when:",
        "      expression: \"true\"",
        "    target: workflow:implementation",
        ""
      ].join("\n")
    );

    await expect(
      loadRoutingDefinition(projectRoot, { LUNA_CONFIG_ROOT: configRoot })
    ).resolves.toMatchObject({
      rules: [{ id: "external_config_root_route" }]
    });
  });

  it("validates invocation JSON before executing a target", async () => {
    const invocationFile = path.join(
      await mkdtemp(path.join(tmpdir(), "luna-cli-invalid-")),
      "invocation.json"
    );
    await writeFile(invocationFile, JSON.stringify({ ...validInvocation, pull_number: 0 }));
    const targetExecutor = { execute: vi.fn(async () => 0) };

    await expect(
      main(["run", "--input", invocationFile], { targetExecutor })
    ).rejects.toThrow(expect.objectContaining({ code: "invocation_invalid" }));
    expect(targetExecutor.execute).not.toHaveBeenCalled();
  });

  it("uses the injected platform as the default adapter registry and workflow runner", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-cli-platform-"));
    const configRoot = path.join(projectRoot, "config");
    const load = vi.fn(async () => validInvocation);
    const adapter: InputAdapter = {
      id: "custom-url",
      description: "Custom URL",
      load
    };
    const platform = {
      inputAdapterRegistry: registryWith(adapter, "github"),
      runWorkflow: vi.fn(async () => undefined),
      resumeWorkflow: vi.fn(async () => succeededWorkflowResult())
    } satisfies Pick<
      LunaPlatform,
      "inputAdapterRegistry" | "runWorkflow" | "resumeWorkflow"
    >;

    await expect(
      main(
        [
          "run",
          "--from",
          "custom-url",
          "https://example.test/task/1"
        ],
        {
          platform,
          projectRoot,
          env: { LUNA_CONFIG_ROOT: configRoot },
          routing: {
            type: "router",
            version: "2026-06",
            rules: [
              {
                id: "platform_route",
                when: { expression: "true" },
                target: "workflow:implementation"
              }
            ]
          }
        }
      )
    ).resolves.toBe(0);

    expect(load).toHaveBeenCalledWith(
      { kind: "cli", value: "https://example.test/task/1" },
      expect.objectContaining({ projectRoot, configRoot })
    );
    expect(platform.runWorkflow).toHaveBeenCalledWith({
      projectRoot,
      configRoot,
      invocation: validInvocation,
      target: { type: "workflow", id: "implementation" }
    });
  });

  it("uses the injected platform for generic workflow resume", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-cli-resume-"));
    const configRoot = path.join(projectRoot, "config");
    const platform = {
      inputAdapterRegistry: registryWith({
        id: "unused",
        description: "Unused",
        load: vi.fn()
      }),
      runWorkflow: vi.fn(async () => undefined),
      resumeWorkflow: vi.fn(async () => succeededWorkflowResult())
    } satisfies Pick<
      LunaPlatform,
      "inputAdapterRegistry" | "runWorkflow" | "resumeWorkflow"
    >;

    await expect(
      main(
        [
          "resume",
          "--target",
          "workflow:implementation",
          "--thread",
          "run-1",
          "--checkpoint",
          "checkpoint-run-1-approval",
          "--interrupt",
          "interrupt-run-1-approval",
          "--decision",
          "{\"approved\":true}"
        ],
        {
          platform,
          projectRoot,
          env: { LUNA_CONFIG_ROOT: configRoot }
        }
      )
    ).resolves.toBe(0);

    expect(platform.runWorkflow).not.toHaveBeenCalled();
    expect(platform.resumeWorkflow).toHaveBeenCalledWith({
      projectRoot,
      configRoot,
      target: { type: "workflow", id: "implementation" },
      thread_id: "run-1",
      checkpoint_id: "checkpoint-run-1-approval",
      interrupt_id: "interrupt-run-1-approval",
      decision: { approved: true }
    });
  });

  it("starts the webhook server with resolved config and CLI overrides", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-cli-webhook-server-"));
    const configRoot = path.join(projectRoot, "config");
    const platform = webhookPlatform();
    const webhookProviderRegistry = defineWebhookProviderAdapterFactories([]);
    const startWebhookServer = vi.fn(async () => undefined);
    await writeCliProjectConfig({ projectRoot, configRoot });

    await expect(
      main(
        [
          "webhook-server",
          "--host",
          "0.0.0.0",
          "--port",
          "9001"
        ],
        {
          platform,
          webhookProviderRegistry,
          projectRoot,
          env: { LUNA_CONFIG_ROOT: configRoot },
          startWebhookServer
        }
      )
    ).resolves.toBe(0);

    expect(startWebhookServer).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot,
        configRoot,
        webhookProviderRegistry,
        config: expect.objectContaining({
          server: expect.objectContaining({
            host: "0.0.0.0",
            port: 9001
          })
        })
      })
    );
  });

  it("starts Luna Studio with resolved roots and loopback overrides", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-cli-studio-"));
    const configRoot = path.join(projectRoot, "config");
    const startStudioServer = vi.fn(async () => undefined);
    const studioOutput = { write: vi.fn() };
    await writeCliProjectConfig({ projectRoot, configRoot });

    await expect(
      main(
        [
          "studio",
          "--host",
          "127.0.0.1",
          "--port",
          "43111"
        ],
        {
          projectRoot,
          env: { LUNA_CONFIG_ROOT: configRoot },
          startStudioServer,
          studioOutput
        }
      )
    ).resolves.toBe(0);

    expect(startStudioServer).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot,
        configRoot,
        host: "127.0.0.1",
        port: 43_111,
        output: studioOutput,
        app: expect.objectContaining({
          workspace: expect.any(Object),
          artifacts: expect.any(Object)
        })
      })
    );
  });

  it("starts the webhook worker with resolved config and CLI overrides", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-cli-webhook-worker-"));
    const configRoot = path.join(projectRoot, "config");
    const platform = webhookPlatform();
    const targetExecutor = { execute: vi.fn(async () => 0) };
    const startWebhookWorker = vi.fn(async () => undefined);
    await writeCliProjectConfig({ projectRoot, configRoot, workerConcurrency: 2 });

    await expect(
      main(
        [
          "webhook-worker",
          "--concurrency",
          "6"
        ],
        {
          platform,
          projectRoot,
          env: { LUNA_CONFIG_ROOT: configRoot },
          targetExecutor,
          startWebhookWorker
        }
      )
    ).resolves.toBe(0);

    expect(startWebhookWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot,
        configRoot,
        targetExecutor,
        routing: expect.objectContaining({
          rules: [expect.objectContaining({ id: "cli_webhook_route" })]
        }),
        config: expect.objectContaining({
          worker: { concurrency: 6 }
        })
      })
    );
  });

});
