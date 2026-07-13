import { describe, expect, it, vi } from "vitest";
import {
  repositoryValidationConfigurationBuiltIn,
  runValidationCommandsBuiltIn
} from "../../src/capabilities/validation/built-ins.js";
import { runValidationCommands } from "../../src/capabilities/validation/command-runner.js";

describe("validation runner", () => {
  it("runs no process when the command list is empty", async () => {
    const runProcess = vi.fn();

    await expect(runValidationCommands({
      cwd: "/repo",
      commands: [],
      envAllowlist: [],
      maxOutputBytes: 1000,
      runProcess
    })).resolves.toEqual({ passed: true, commands: [] });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("returns passed false for non-zero exit codes without throwing", async () => {
    const result = await runValidationCommands({
      cwd: "/repo",
      commands: [{ cmd: "quality-check", args: ["verify"], timeout_ms: 120000 }],
      envAllowlist: [],
      maxOutputBytes: 1000,
      runProcess: async () => ({
        exitCode: 1,
        stdout: "failing tests",
        stderr: "",
        timedOut: false,
        durationMs: 25
      })
    });

    expect(result.passed).toBe(false);
    expect(result.commands[0]).toMatchObject({
      cmd: "quality-check",
      args: ["verify"],
      exit_code: 1,
      stdout: "failing tests",
      timed_out: false
    });
  });

  it("marks timed out commands and treats them as failed", async () => {
    const result = await runValidationCommands({
      cwd: "/repo",
      commands: [{ cmd: "quality-check", args: ["types"], timeout_ms: 10 }],
      envAllowlist: [],
      maxOutputBytes: 1000,
      runProcess: async () => ({
        exitCode: null,
        stdout: "still running",
        stderr: "timeout",
        timedOut: true,
        durationMs: 10
      })
    });

    expect(result.passed).toBe(false);
    expect(result.commands[0].exit_code).toBeNull();
    expect(result.commands[0].timed_out).toBe(true);
  });

  it("records stdout and stderr truncation metadata", async () => {
    const result = await runValidationCommands({
      cwd: "/repo",
      commands: [{ cmd: "quality-check", args: ["verify"] }],
      envAllowlist: [],
      maxOutputBytes: 5,
      runProcess: async () => ({
        exitCode: 0,
        stdout: "abcdef",
        stderr: "123456",
        timedOut: false,
        durationMs: 4
      })
    });

    expect(result.passed).toBe(true);
    expect(result.commands[0]).toMatchObject({
      stdout: "abcde",
      stderr: "12345",
      stdout_truncated: true,
      stderr_truncated: true
    });
  });

  it("captures output larger than execFile's default buffer and applies truncation metadata", async () => {
    const result = await runValidationCommands({
      cwd: process.cwd(),
      commands: [
        {
          cmd: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeSync(1, 'a'.repeat(1024 * 1024 + 1))"
          ]
        }
      ],
      envAllowlist: [],
      maxOutputBytes: 32
    });

    expect(result.passed).toBe(true);
    expect(result.commands[0]).toMatchObject({
      exit_code: 0,
      stdout: "a".repeat(32),
      stderr: "",
      stdout_truncated: true,
      stderr_truncated: false,
      timed_out: false
    });
  });

  it("passes structured argv to the process runner without a shell command string", async () => {
    const calls: unknown[] = [];

    await runValidationCommands({
      cwd: "/repo",
      commands: [{ cmd: "quality-check", args: ["--all"] }],
      envAllowlist: [],
      maxOutputBytes: 1000,
      sourceEnvironment: { PATH: "/safe/bin", SECRET_TOKEN: "must-not-leak" },
      runProcess: async (request) => {
        calls.push(request);

        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          durationMs: 3
        };
      }
    });

    expect(calls).toEqual([
      {
        cmd: "quality-check",
        args: ["--all"],
        cwd: "/repo",
        env: {
          PATH: "/safe/bin",
          HOME: expect.stringMatching(/luna-validation-home-/)
        },
        maxOutputBytes: 1000,
        timeoutMs: undefined
      }
    ]);
  });

  it("passes PATH and explicitly allowlisted variables without leaking other env", async () => {
    const result = await runValidationCommands({
      cwd: process.cwd(),
      commands: [
        {
          cmd: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeSync(1, JSON.stringify({ path: process.env.PATH, home: process.env.HOME, allowed: process.env.ALLOWED_TOKEN, secret: process.env.SECRET_TOKEN }))"
          ]
        }
      ],
      envAllowlist: ["ALLOWED_TOKEN", "HOME"],
      maxOutputBytes: 1000,
      sourceEnvironment: {
        PATH: "/safe/bin",
        HOME: "/credential-bearing-home",
        ALLOWED_TOKEN: "visible",
        SECRET_TOKEN: "must-not-leak"
      }
    });

    expect(result).toMatchObject({ passed: true });
    const environment = JSON.parse(result.commands[0].stdout) as {
      path: string;
      home: string;
      allowed: string;
    };
    expect(environment).toEqual({
      path: "/safe/bin",
      home: expect.stringMatching(/luna-validation-home-/),
      allowed: "visible"
    });
    expect(environment.home).not.toBe("/credential-bearing-home");
    expect(result.commands[0].stdout).not.toContain("must-not-leak");
  });
});

describe("validation.run_commands built-in", () => {
  it("runs only explicit validation input", async () => {
    const execute = vi.fn(async () => ({ passed: true, commands: [] }));

    await expect(
      runValidationCommandsBuiltIn.run({
        state: {
          invocation: {},
          config: {},
          workspace: { path: "/repo/worktree" },
          steps: {}
        },
        input: {
          commands: [{ cmd: "quality-check", args: ["--all"] }],
          env_allowlist: ["ALLOWED_TOKEN"],
          max_output_bytes: 2048
        },
        dependencies: { runValidationCommands: execute }
      })
    ).resolves.toMatchObject({ passed: true });

    expect(execute).toHaveBeenCalledWith({
      cwd: "/repo/worktree",
      commands: [{ cmd: "quality-check", args: ["--all"] }],
      envAllowlist: ["ALLOWED_TOKEN"],
      maxOutputBytes: 2048
    });
  });

  it("returns an empty command list when repository validation is missing", () => {
    expect(repositoryValidationConfigurationBuiltIn.run({
      state: {
        invocation: {},
        repository: {
          id: "repo",
          provider: "git",
          owner: "example",
          name: "repo",
          path: "/repo",
          remote: "origin"
        },
        steps: {}
      }
    })).toEqual({ commands: [], env_allowlist: [] });
  });

  it("returns the selected repository validation policy", () => {
    const validation = {
      commands: [{ cmd: "./scripts/validate" }],
      env_allowlist: []
    };
    expect(repositoryValidationConfigurationBuiltIn.run({
      state: {
        invocation: {},
        repository: {
          id: "repo",
          provider: "git",
          owner: "example",
          name: "repo",
          path: "/repo",
          remote: "origin",
          validation
        },
        steps: {}
      }
    })).toEqual(validation);
  });
});
