import { describe, expect, it, vi } from "vitest";
import { runAgentLoopStateMachine } from "../../src/core/agents/loop-runner.js";
import { AgentLoopResultSchema } from "../../src/core/agent-runtime/contracts.js";
import type { ValidationResult } from "../../src/core/validation/runner.js";

const passedValidation: ValidationResult = { passed: true };
const failedValidation: ValidationResult = { passed: false };
const cwd = "/repo/worktree";
const prompt = { task: "ABC-123" };

describe("agent loop runner", () => {
  it("requires validation and result status on agent loop result artifacts", () => {
    expect(
      AgentLoopResultSchema.parse({
        status: "passed",
        attempts_exhausted: false,
        attempts: [],
        validation: { passed: true },
        final_validation: { passed: true },
        result: { status: "passed", summary: "Validation passed." }
      })
    ).toMatchObject({
      status: "passed",
      validation: { passed: true },
      final_validation: { passed: true }
    });

    expect(() =>
      AgentLoopResultSchema.parse({
        status: "passed",
        attempts_exhausted: false,
        attempts: [],
        final_validation: { passed: true },
        result: { status: "passed", summary: "Validation passed." }
      })
    ).toThrow();

    expect(() =>
      AgentLoopResultSchema.parse({
        status: "passed",
        attempts_exhausted: false,
        attempts: [],
        validation: { passed: true },
        final_validation: { passed: true },
        result: { summary: "Validation passed." }
      })
    ).toThrow();
  });

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

    expect(AgentLoopResultSchema.parse(output)).toEqual(output);
    expect(output).toEqual({
      status: "passed",
      attempts_exhausted: false,
      attempts: [
        {
          attempt: 1,
          phase: "initial",
          agent_output: { summary: "implemented" },
          validation: passedValidation,
          diff_summary: { files: ["src/checkout.ts"] }
        }
      ],
      validation: passedValidation,
      final_validation: passedValidation,
      result: {
        status: "passed",
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
    const firstDiffSummary = { files: ["src/partial.ts"] };
    const finalDiffSummary = { files: ["src/fix.ts"] };
    const collectDiffSummary = vi
      .fn()
      .mockResolvedValueOnce(firstDiffSummary)
      .mockResolvedValueOnce(finalDiffSummary);

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
    expect(output.final_validation).toBe(passedValidation);
    expect(output.attempts_exhausted).toBe(false);
    expect(output.attempts).toEqual([
      {
        attempt: 1,
        phase: "initial",
        agent_output: { summary: "first pass" },
        validation: failedValidation,
        diff_summary: firstDiffSummary
      },
      {
        attempt: 2,
        phase: "repair",
        agent_output: { summary: "repair pass" },
        validation: passedValidation,
        diff_summary: finalDiffSummary
      }
    ]);
    expect(output.result).toMatchObject({
      status: "passed",
      agent_output: { summary: "repair pass" },
      diff_summary: finalDiffSummary
    });
    expect(runWritableAgent).toHaveBeenLastCalledWith({
      cwd,
      prompt,
      attempt: 2,
      phase: "repair",
      previousValidation: failedValidation,
      previousError: undefined,
      diffSummary: firstDiffSummary
    });
    expect(collectDiffSummary).toHaveBeenCalledTimes(2);
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
      attempts_exhausted: true,
      attempts: [
        {
          attempt: 1,
          phase: "initial",
          agent_output: { summary: "not enough" },
          validation: failedValidation,
          diff_summary: { files: ["src/partial.ts"] }
        }
      ],
      validation: failedValidation,
      final_validation: failedValidation,
      result: {
        status: "failed",
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
        agent_error: { message: "agent crashed" },
        diff_summary: { files: [] }
      },
      {
        attempt: 2,
        phase: "repair",
        agent_output: { summary: "recovered" },
        validation: passedValidation,
        diff_summary: { files: [] }
      }
    ]);
    expect(runWritableAgent).toHaveBeenLastCalledWith({
      cwd,
      prompt,
      attempt: 2,
      phase: "repair",
      previousValidation: undefined,
      previousError: { message: "agent crashed" },
      diffSummary: { files: [] }
    });
  });

  it("throws a coded infrastructure error when the final agent attempt fails", async () => {
    const cause = new Error("agent crashed for good");
    const runWritableAgent = vi.fn(async () => {
      throw cause;
    });
    const runValidation = vi.fn(async () => passedValidation);
    const collectDiffSummary = vi.fn(async () => ({ files: [] }));

    await expect(
      runAgentLoopStateMachine({
        cwd,
        prompt,
        repairAttempts: 0,
        dependencies: {
          runWritableAgent,
          runValidation,
          collectDiffSummary
        }
      })
    ).rejects.toMatchObject({
      code: "agent_loop_infrastructure_failure",
      cause
    });

    expect(runValidation).not.toHaveBeenCalled();
    expect(collectDiffSummary).toHaveBeenCalledTimes(1);
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
      attempts_exhausted: true,
      validation: { passed: false },
      final_validation: { passed: false },
      result: {
        status: "failed"
      }
    });
    expect(Object.keys(output)).toEqual(
      expect.arrayContaining([
        "attempts",
        "attempts_exhausted",
        "validation",
        "final_validation",
        "result"
      ])
    );
  });
});
