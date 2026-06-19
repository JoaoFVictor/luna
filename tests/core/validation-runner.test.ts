import { describe, expect, it } from "vitest";
import { runValidationCommands } from "../../src/core/validation-runner.js";

describe("validation runner", () => {
  it("returns passed false for non-zero exit codes without throwing", async () => {
    const result = await runValidationCommands({
      cwd: "/repo",
      commands: [{ cmd: "npm", args: ["test"], timeout_ms: 120000 }],
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
      cmd: "npm",
      args: ["test"],
      exit_code: 1,
      stdout: "failing tests",
      timed_out: false
    });
  });

  it("marks timed out commands and treats them as failed", async () => {
    const result = await runValidationCommands({
      cwd: "/repo",
      commands: [{ cmd: "npm", args: ["run", "typecheck"], timeout_ms: 10 }],
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
      commands: [{ cmd: "npm", args: ["test"] }],
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

  it("passes structured argv to the process runner without a shell command string", async () => {
    const calls: unknown[] = [];

    await runValidationCommands({
      cwd: "/repo",
      commands: [{ cmd: "npm", args: ["run", "typecheck"] }],
      maxOutputBytes: 1000,
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
        cmd: "npm",
        args: ["run", "typecheck"],
        cwd: "/repo",
        timeoutMs: undefined
      }
    ]);
  });
});
