import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { InputAdapterRegistry } from "../../src/adapters/registry.js";
import type { AdapterContext, InputAdapter } from "../../src/adapters/types.js";
import type { Invocation } from "../../src/core/router/invocation.js";
import {
  findProjectRoot,
  loadInvocationFromFile,
  loadRoutingDefinition,
  main,
  parseCliArgs,
  parseWorkflowTarget,
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

const adapterContext: AdapterContext = {
  projectRoot: "/workspace/project",
  configRoot: "/workspace/config",
  env: {},
  fetch,
  executeJson: vi.fn()
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

describe("Luna CLI", () => {
  it("keeps the package bin pointed at the emitted CLI path", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      bin?: { luna?: unknown };
    };

    expect(packageJson.bin?.luna).toBe("./dist/src/cli.js");
    await expect(access("src/cli.ts")).resolves.toBeUndefined();
  });

  it("parses run input arguments", () => {
    expect(parseCliArgs(["run", "--input", "example.json"])).toEqual({
      command: "run",
      input: "example.json",
      target: undefined
    });
  });

  it("parses explicit target input adapter arguments", () => {
    expect(
      parseCliArgs([
        "run",
        "--target",
        "workflow:code-review",
        "--from",
        "github-pr-url",
        "https://github.com/withastro/luna/pull/123"
      ])
    ).toEqual({
      command: "run",
      target: { type: "workflow", id: "code-review" },
      from: "github-pr-url",
      value: "https://github.com/withastro/luna/pull/123"
    });
  });

  it("parses workflow targets", () => {
    expect(parseWorkflowTarget("workflow:implementation")).toEqual({
      type: "workflow",
      id: "implementation"
    });
  });

  it("rejects invalid or workflow-specific command shapes", () => {
    expect(() => parseWorkflowTarget("agent:implementation")).toThrow(
      expect.objectContaining({ code: "invalid_target" })
    );
    expect(() => parseCliArgs(["run", "--workflow", "code-review"])).toThrow(
      expect.objectContaining({ code: "unsupported_flag" })
    );
    expect(() => parseCliArgs(["review-pr", "url"])).toThrow(
      expect.objectContaining({ code: "unknown_command" })
    );
  });

  it("finds the project root from compiled dist paths", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-cli-root-"));
    const nestedStart = path.join(projectRoot, "dist", "src", "core");

    await mkdir(nestedStart, { recursive: true });
    await writeFile(path.join(projectRoot, "package.json"), "{}");

    await expect(findProjectRoot(nestedStart)).resolves.toBe(projectRoot);
  });

  it("loads routing from the app-configured router path", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-cli-routing-"));
    const configRoot = path.join(projectRoot, "config");
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
        "routing:",
        "  path: cli-routing.yaml",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(configRoot, "cli-routing.yaml"),
      [
        "type: router",
        "version: \"2026-06\"",
        "rules:",
        "  - id: cli_override_route",
        "    when:",
        "      expression: \"true\"",
        "    target: workflow:code-review",
        ""
      ].join("\n")
    );

    await expect(loadRoutingDefinition(projectRoot)).resolves.toMatchObject({
      rules: [{ id: "cli_override_route" }]
    });
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

    expect(
      resolveCliConfigRoot(projectRoot, { LUNA_CONFIG_ROOT: configRoot })
    ).toBe(configRoot);
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

  it("loads a validated invocation from disk", async () => {
    const invocationFile = path.join(
      await mkdtemp(path.join(tmpdir(), "luna-cli-load-")),
      "invocation.json"
    );
    await writeFile(invocationFile, JSON.stringify(validInvocation));

    await expect(loadInvocationFromFile(invocationFile)).resolves.toEqual(validInvocation);
  });

  it("loads an invocation through an adapter, routes it, and executes natively", async () => {
    const targetExecutor = { execute: vi.fn(async () => 0) };
    const load = vi.fn(async () => validInvocation);
    const adapter: InputAdapter = {
      id: "github-pr-url",
      description: "GitHub pull request URL",
      load
    };

    await expect(
      main(
        [
          "run",
          "--target",
          "workflow:code-review",
          "--from",
          "github-pr-url",
          "https://github.com/octo-org/hello-world/pull/42"
        ],
        {
          targetExecutor,
          adapterRegistry: registryWith(adapter),
          adapterContext
        }
      )
    ).resolves.toBe(0);

    expect(load).toHaveBeenCalledWith(
      { kind: "cli", value: "https://github.com/octo-org/hello-world/pull/42" },
      adapterContext
    );
    expect(targetExecutor.execute).toHaveBeenCalledWith({
      invocation: {
        ...validInvocation,
        target: { type: "workflow", id: "code-review" }
      },
      target: { type: "workflow", id: "code-review" }
    });
  });
});
