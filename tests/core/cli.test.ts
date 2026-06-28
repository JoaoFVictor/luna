import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { InputAdapterRegistry } from "../../src/adapters/registry.js";
import type { InputAdapter } from "../../src/adapters/types.js";
import type { Invocation } from "../../src/core/router/invocation.js";
import { createInitialRuntimeState } from "../../src/core/runtime/state.js";
import type { WorkflowRunResult } from "../../src/core/workflow/execution-contracts.js";
import type { LunaPlatform } from "../../src/platform/native/native-platform.js";
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

function registryWith(adapter: InputAdapter): InputAdapterRegistry {
  return {
    get(id) {
      return id === adapter.id ? adapter : undefined;
    },
    require(id) {
      if (id !== adapter.id) {
        throw new Error(`Unexpected adapter id: ${id}`);
      }

      return adapter;
    },
    ids() {
      return [adapter.id];
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
        "  path: external-routing.yaml",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(configRoot, "external-routing.yaml"),
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
      inputAdapterRegistry: registryWith(adapter),
      runWorkflow: vi.fn(async () => undefined),
      resumeWorkflow: vi.fn(async () => succeededWorkflowResult())
    } satisfies Pick<LunaPlatform, "inputAdapterRegistry" | "runWorkflow" | "resumeWorkflow">;

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
    } satisfies Pick<LunaPlatform, "inputAdapterRegistry" | "runWorkflow" | "resumeWorkflow">;

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

});
