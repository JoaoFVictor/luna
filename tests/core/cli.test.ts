import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Invocation } from "../../src/core/types.js";
import {
  buildFlueRunCommand,
  childProcessExitCode,
  childProcessFailureExitCode,
  findProjectRoot,
  loadInvocationFromFile,
  main,
  parseCliArgs,
  resolveFlueCliBin
} from "../../src/core/flue-cli.js";

const validInvocation: Invocation = {
  target: "github_pr",
  owner: "octo-org",
  repo: "hello-world",
  pull_number: 42,
  base_ref: "main",
  base_repository: {
    owner: "octo-org",
    name: "hello-world",
    full_name: "octo-org/hello-world"
  },
  head_repository: {
    owner: "contributor",
    name: "hello-world",
    full_name: "contributor/hello-world",
    fork: true
  },
  references: {
    base_sha: "abc123",
    head_sha: "def456"
  }
};

const validJiraInvocation: Invocation = {
  target: "jira_task",
  workflow: "implementation",
  jira: {
    instance_id: "company",
    issue_key: "ABC-123",
    url: "https://company.atlassian.net/browse/ABC-123",
    summary: "Fix checkout validation",
    description: "Reject invalid checkout payloads.",
    acceptance_criteria: "Invalid payloads fail validation.",
    status: "To Do",
    issue_type: "Task"
  },
  repository: {
    provider: "github",
    owner: "swinggo-dev",
    name: "swg-front-nuxt"
  }
};

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
      workflow: undefined
    });
  });

  it("parses workflow input adapter arguments", () => {
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
      workflow: "code-review",
      from: "github-pr-url",
      value: "https://github.com/withastro/luna/pull/123"
    });
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
    const loadPullRequestInvocation = vi.fn(async () => validInvocation);

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
          loadPullRequestInvocation
        }
      )
    ).resolves.toBe(0);

    expect(loadPullRequestInvocation).toHaveBeenCalledWith(
      "https://github.com/octo-org/hello-world/pull/42"
    );
    expect(buildCommand).toHaveBeenCalledWith({
      ...validInvocation,
      workflow: "code-review"
    });
    expect(execute).toHaveBeenCalledWith(process.execPath, ["local-flue"]);
  });

  it("loads a Jira task invocation through the selected input adapter before invoking Flue", async () => {
    const execute = vi.fn(async () => 0);
    const buildCommand = vi.fn(async () => ({
      command: process.execPath,
      args: ["local-flue"]
    }));
    const loadJiraTaskInvocation = vi.fn(async () => validJiraInvocation);

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
          loadJiraTaskInvocation
        }
      )
    ).resolves.toBe(0);

    expect(loadJiraTaskInvocation).toHaveBeenCalledWith(
      "https://company.atlassian.net/browse/ABC-123"
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
