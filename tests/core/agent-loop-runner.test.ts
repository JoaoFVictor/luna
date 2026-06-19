import { describe, expect, it, vi } from "vitest";
import { runAgentLoopStateMachine } from "../../src/core/agent-loop-runner.js";
import type { ValidationResult } from "../../src/core/types.js";

const passedValidation: ValidationResult = { passed: true };
const failedValidation: ValidationResult = { passed: false };
const cwd = "/repo/worktree";
const prompt = { task: "ABC-123" };

describe("agent loop runner", () => {
  it("passes on the first attempt", async () => {
    const runWritableAgent = vi.fn(async () => ({ summary: "implemented" }));
    const runValidation = vi.fn(async () => passedValidation);
    const collectDiffSummary = vi.fn(async () => ({
      files: ["src/checkout.ts"]
    }));

    const output = await runAgentLoopStateMachine({
      cwd,
      prompt,
      repairAttempts: 1,
      dependencies: {
        runWritableAgent,
        runValidation,
        collectDiffSummary
      }
    });

    expect(output).toEqual({
      status: "passed",
      attempts: [
        {
          attempt: 1,
          phase: "initial",
          agent_output: { summary: "implemented" },
          validation: passedValidation
        }
      ],
      validation: passedValidation,
      result: {
        status: "passed",
        attempts_exhausted: false,
        agent_output: { summary: "implemented" },
        diff_summary: { files: ["src/checkout.ts"] }
      }
    });
    expect(runWritableAgent).toHaveBeenCalledTimes(1);
    expect(runWritableAgent).toHaveBeenCalledWith({
      cwd,
      prompt,
      attempt: 1,
      phase: "initial",
      previousValidation: undefined,
      previousError: undefined
    });
    expect(runValidation).toHaveBeenCalledTimes(1);
    expect(collectDiffSummary).toHaveBeenCalledTimes(1);
  });

  it("repairs after a failed first attempt", async () => {
    const runWritableAgent = vi
      .fn()
      .mockResolvedValueOnce({ summary: "first pass" })
      .mockResolvedValueOnce({ summary: "repair pass" });
    const runValidation = vi
      .fn()
      .mockResolvedValueOnce(failedValidation)
      .mockResolvedValueOnce(passedValidation);
    const collectDiffSummary = vi.fn(async () => ({ files: ["src/fix.ts"] }));

    const output = await runAgentLoopStateMachine({
      cwd,
      prompt,
      repairAttempts: 1,
      dependencies: {
        runWritableAgent,
        runValidation,
        collectDiffSummary
      }
    });

    expect(output.status).toBe("passed");
    expect(output.validation).toBe(passedValidation);
    expect(output.attempts).toEqual([
      {
        attempt: 1,
        phase: "initial",
        agent_output: { summary: "first pass" },
        validation: failedValidation
      },
      {
        attempt: 2,
        phase: "repair",
        agent_output: { summary: "repair pass" },
        validation: passedValidation
      }
    ]);
    expect(output.result).toMatchObject({
      status: "passed",
      attempts_exhausted: false,
      agent_output: { summary: "repair pass" },
      diff_summary: { files: ["src/fix.ts"] }
    });
    expect(runWritableAgent).toHaveBeenLastCalledWith({
      cwd,
      prompt,
      attempt: 2,
      phase: "repair",
      previousValidation: failedValidation,
      previousError: undefined
    });
  });

  it("returns failed artifacts when attempts are exhausted", async () => {
    const runWritableAgent = vi.fn(async () => ({ summary: "not enough" }));
    const runValidation = vi.fn(async () => failedValidation);
    const collectDiffSummary = vi.fn(async () => ({
      files: ["src/partial.ts"]
    }));

    const output = await runAgentLoopStateMachine({
      cwd,
      prompt,
      repairAttempts: 0,
      dependencies: {
        runWritableAgent,
        runValidation,
        collectDiffSummary
      }
    });

    expect(output).toEqual({
      status: "failed",
      attempts: [
        {
          attempt: 1,
          phase: "initial",
          agent_output: { summary: "not enough" },
          validation: failedValidation
        }
      ],
      validation: failedValidation,
      result: {
        status: "failed",
        attempts_exhausted: true,
        agent_output: { summary: "not enough" },
        diff_summary: { files: ["src/partial.ts"] }
      }
    });
  });

  it("records an agent error and uses it for the repair attempt", async () => {
    const runWritableAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error("agent crashed"))
      .mockResolvedValueOnce({ summary: "recovered" });
    const runValidation = vi.fn(async () => passedValidation);
    const collectDiffSummary = vi.fn(async () => ({ files: [] }));

    const output = await runAgentLoopStateMachine({
      cwd,
      prompt,
      repairAttempts: 1,
      dependencies: {
        runWritableAgent,
        runValidation,
        collectDiffSummary
      }
    });

    expect(output.status).toBe("passed");
    expect(output.attempts).toEqual([
      {
        attempt: 1,
        phase: "initial",
        agent_error: { message: "agent crashed" }
      },
      {
        attempt: 2,
        phase: "repair",
        agent_output: { summary: "recovered" },
        validation: passedValidation
      }
    ]);
    expect(runWritableAgent).toHaveBeenLastCalledWith({
      cwd,
      prompt,
      attempt: 2,
      phase: "repair",
      previousValidation: undefined,
      previousError: { message: "agent crashed" }
    });
  });

  it("keeps artifact mapping keys at the top level", async () => {
    const output = await runAgentLoopStateMachine({
      cwd,
      prompt,
      repairAttempts: -1,
      dependencies: {
        runWritableAgent: vi.fn(),
        runValidation: vi.fn(),
        collectDiffSummary: vi.fn()
      }
    });

    expect(output).toMatchObject({
      attempts: [],
      validation: { passed: false },
      result: {
        status: "failed",
        attempts_exhausted: true
      }
    });
    expect(Object.keys(output)).toEqual(
      expect.arrayContaining(["attempts", "validation", "result"])
    );
  });
});
