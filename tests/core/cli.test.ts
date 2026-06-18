import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Invocation } from "../../src/core/types.js";
import {
  buildFlueRunCommand,
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
      input: "example.json"
    });
  });

  it("throws missing_input when run input is missing", () => {
    expect(() => parseCliArgs(["run"])).toThrow(
      expect.objectContaining({ code: "missing_input" })
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
      "code-review",
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

  it("does not import or call the code-review workflow directly", async () => {
    vi.resetModules();
    vi.doMock("../../src/workflows/code-review.js", () => {
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
    vi.doUnmock("../../src/workflows/code-review.js");
    vi.resetModules();
  });

  it("maps child process signal termination to conventional exit code", () => {
    expect(childProcessFailureExitCode({ signal: "SIGTERM" })).toBe(143);
  });
});
