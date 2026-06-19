import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { InputAdapterRegistry } from "../../src/adapters/registry.js";
import type { AdapterContext, InputAdapter } from "../../src/adapters/types.js";
import type { Invocation } from "../../src/core/types.js";
import {
  buildFlueRunCommand,
  childProcessExitCode,
  childProcessFailureExitCode,
  findProjectRoot,
  loadInvocationFromFile,
  main,
  parseCliArgs,
  parseWorkflowTarget,
  resolveFlueCliBin
} from "../../src/core/flue-cli.js";

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
  payload: {
    pull_request: {
      number: 42
    }
  }
};

const validJiraInvocation: Invocation = {
  version: "2026-06",
  source: "jira",
  event: "issue",
  action: "selected",
  repository: {
    provider: "github",
    owner: "swinggo-dev",
    name: "swg-front-nuxt"
  },
  subject: {
    type: "jira_issue",
    id: "ABC-123",
    url: "https://company.atlassian.net/browse/ABC-123",
    title: "Fix checkout validation"
  },
  payload: {
    jira: {
      instance_id: "company",
      description: "Reject invalid checkout payloads.",
      acceptance_criteria: "Invalid payloads fail validation.",
      status: "To Do",
      issue_type: "Task"
    }
  }
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

describe("flue local CLI wrapper", () => {
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

  it("parses workflow as a target alias for input adapter arguments", () => {
    expect(
      parseCliArgs([
        "run",
        "--workflow",
        "code-review",
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

  it("throws invalid_target when the target is not a workflow target", () => {
    expect(() => parseWorkflowTarget("agent:implementation")).toThrow(
      expect.objectContaining({ code: "invalid_target" })
    );
  });

  it("throws ambiguous_target when workflow and target are both provided", () => {
    expect(() =>
      parseCliArgs([
        "run",
        "--workflow",
        "code-review",
        "--target",
        "workflow:implementation",
        "--input",
        "input.json"
      ])
    ).toThrow(expect.objectContaining({ code: "ambiguous_target" }));
  });

  it("throws missing_input when run input is missing", () => {
    expect(() => parseCliArgs(["run"])).toThrow(
      expect.objectContaining({ code: "missing_input" })
    );
  });

  it("throws missing_from_value when an input adapter value is missing", () => {
    expect(() =>
      parseCliArgs(["run", "--workflow", "code-review", "--from", "github-pr-url"])
    ).toThrow(
      expect.objectContaining({ code: "missing_from_value" })
    );
  });

  it("resolves the local @flue/cli binary from package bin.flue", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-cli-bin-"));
    await mkdir(path.join(projectRoot, "node_modules", "@flue", "cli"), {
      recursive: true
    });
    await writeFile(
      path.join(projectRoot, "node_modules", "@flue", "cli", "package.json"),
      JSON.stringify({ bin: { flue: "dist/index.js" } })
    );

    await expect(resolveFlueCliBin(projectRoot)).resolves.toBe(
      path.join(projectRoot, "node_modules", "@flue", "cli", "dist", "index.js")
    );
  });

  it("finds the project root from compiled dist paths", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-cli-root-"));
    const nestedStart = path.join(projectRoot, "dist", "src", "core");

    await mkdir(nestedStart, { recursive: true });
    await mkdir(path.join(projectRoot, "node_modules", "@flue", "cli"), {
      recursive: true
    });
    await writeFile(path.join(projectRoot, "package.json"), "{}");
    await writeFile(
      path.join(projectRoot, "node_modules", "@flue", "cli", "package.json"),
      JSON.stringify({ bin: { flue: "bin/flue.mjs" } })
    );

    await expect(findProjectRoot(nestedStart)).resolves.toBe(projectRoot);
  });

  it("builds a node command that runs local Flue with the invocation payload", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-cli-command-"));
    await mkdir(path.join(projectRoot, "node_modules", "@flue", "cli"), {
      recursive: true
    });
    await writeFile(
      path.join(projectRoot, "node_modules", "@flue", "cli", "package.json"),
      JSON.stringify({ bin: { flue: "./bin/flue.js" } })
    );

    const command = await buildFlueRunCommand(validInvocation, { projectRoot });

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual([
      path.join(projectRoot, "node_modules", "@flue", "cli", "bin", "flue.js"),
      "run",
      "luna",
      "--target",
      "node",
      "--payload",
      JSON.stringify(validInvocation)
    ]);
  });

  it("validates invocation JSON before invoking Flue", async () => {
    const invocationFile = path.join(
      await mkdtemp(path.join(tmpdir(), "luna-cli-invalid-")),
      "invocation.json"
    );
    await writeFile(invocationFile, JSON.stringify({ ...validInvocation, pull_number: 0 }));
    const execute = vi.fn();

    await expect(
      main(["run", "--input", invocationFile], { execute })
    ).rejects.toThrow(expect.objectContaining({ code: "invocation_invalid" }));
    expect(execute).not.toHaveBeenCalled();
  });

  it("loads a validated invocation from disk", async () => {
    const invocationFile = path.join(
      await mkdtemp(path.join(tmpdir(), "luna-cli-load-")),
      "invocation.json"
    );
    await writeFile(invocationFile, JSON.stringify(validInvocation));

    await expect(loadInvocationFromFile(invocationFile)).resolves.toEqual(validInvocation);
  });

  it("loads an invocation through the selected input adapter before invoking Flue", async () => {
    const execute = vi.fn(async () => 0);
    const buildCommand = vi.fn(async () => ({
      command: process.execPath,
      args: ["local-flue"]
    }));
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
          "--workflow",
          "code-review",
          "--from",
          "github-pr-url",
          "https://github.com/octo-org/hello-world/pull/42"
        ],
        {
          execute,
          buildCommand,
          adapterRegistry: registryWith(adapter),
          adapterContext
        }
      )
    ).resolves.toBe(0);

    expect(load).toHaveBeenCalledWith(
      { kind: "cli", value: "https://github.com/octo-org/hello-world/pull/42" },
      adapterContext
    );
    expect(buildCommand).toHaveBeenCalledWith({
      ...validInvocation,
      target: { type: "workflow", id: "code-review" }
    });
    expect(execute).toHaveBeenCalledWith(process.execPath, ["local-flue"]);
  });

  it("loads a Jira task invocation through the selected input adapter before invoking Flue", async () => {
    const execute = vi.fn(async () => 0);
    const buildCommand = vi.fn(async () => ({
      command: process.execPath,
      args: ["local-flue"]
    }));
    const load = vi.fn(async () => validJiraInvocation);
    const adapter: InputAdapter = {
      id: "jira-task-url",
      description: "Jira task URL",
      load
    };

    await expect(
      main(
        [
          "run",
          "--from",
          "jira-task-url",
          "https://company.atlassian.net/browse/ABC-123"
        ],
        {
          execute,
          buildCommand,
          adapterRegistry: registryWith(adapter),
          adapterContext
        }
      )
    ).resolves.toBe(0);

    expect(load).toHaveBeenCalledWith(
      { kind: "cli", value: "https://company.atlassian.net/browse/ABC-123" },
      adapterContext
    );
    expect(buildCommand).toHaveBeenCalledWith(validJiraInvocation);
    expect(execute).toHaveBeenCalledWith(process.execPath, ["local-flue"]);
  });

  it("does not keep workflow-specific commands in the public CLI", () => {
    expect(() =>
      parseCliArgs(["review-pr", "https://github.com/withastro/luna/pull/123"])
    ).toThrow(expect.objectContaining({ code: "unknown_command" }));
  });

  it("does not import or call workflow modules directly", async () => {
    vi.resetModules();
    vi.doMock("../../src/workflows/luna.js", () => {
      throw new Error("CLI should invoke Flue, not import the workflow");
    });

    const { main: isolatedMain } = await import("../../src/core/flue-cli.js");
    const invocationFile = path.join(
      await mkdtemp(path.join(tmpdir(), "luna-cli-workflow-")),
      "invocation.json"
    );
    await writeFile(invocationFile, JSON.stringify(validInvocation));
    const execute = vi.fn(async () => 0);

    await expect(
      isolatedMain(["run", "--input", invocationFile], {
        execute,
        buildCommand: async () => ({ command: process.execPath, args: ["local-flue"] })
      })
    ).resolves.toBe(0);

    expect(execute).toHaveBeenCalledWith(process.execPath, ["local-flue"]);
    vi.doUnmock("../../src/workflows/luna.js");
    vi.resetModules();
  });

  it("maps child process signal termination to conventional exit code", () => {
    expect(childProcessExitCode(null, "SIGTERM")).toBe(143);
    expect(childProcessFailureExitCode({ signal: "SIGTERM" })).toBe(143);
  });
});
