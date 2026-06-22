import { describe, expect, it, vi } from "vitest";
import { runGatedAgentLoopStateMachine } from "../../src/core/agents/gated-loop-runner.js";
import { GatedAgentLoopResultSchema } from "../../src/core/agent-runtime/contracts.js";
import type { ValidationResult } from "../../src/core/validation/runner.js";

const passedValidation: ValidationResult = { passed: true };
const failedValidation: ValidationResult = { passed: false };
const cwd = "/repo/worktree";
const prompt = { task: "ABC-123" };

describe("gated agent loop runner", () => {
  it("requires validation and result status on gated agent loop result artifacts", () => {
    expect(
      GatedAgentLoopResultSchema.parse({
        status: "passed",
        attempts_exhausted: false,
        attempts: [],
        validation: { passed: true },
        final_validation: { passed: true },
        gates: [],
        result: { status: "passed", summary: "Validation passed." }
      })
    ).toMatchObject({
      status: "passed",
      validation: { passed: true },
      final_validation: { passed: true }
    });

    expect(() =>
      GatedAgentLoopResultSchema.parse({
        status: "passed",
        attempts_exhausted: false,
        attempts: [],
        final_validation: { passed: true },
        gates: [],
        result: { status: "passed", summary: "Validation passed." }
      })
    ).toThrow();

    expect(() =>
      GatedAgentLoopResultSchema.parse({
        status: "passed",
        attempts_exhausted: false,
        attempts: [],
        validation: { passed: true },
        final_validation: { passed: true },
        gates: [],
        result: { summary: "Validation passed." }
      })
    ).toThrow();
  });

  it("passes on the first attempt", async () => {
    const runWorker = vi.fn(async () => ({ summary: "implemented" }));
    const runValidation = vi.fn(async () => passedValidation);
    const collectDiffSummary = vi.fn(async () => ({
      files: ["src/checkout.ts"]
    }));
    const runGates = vi.fn(async () => ({
      passed: true,
      results: [{ id: "review", type: "agent", passed: true }],
      outputs: { review: { findings: [] } }
    }));

    const output = await runGatedAgentLoopStateMachine({
      cwd,
      prompt,
      repairAttempts: 1,
      dependencies: {
        runWorker,
        runValidation,
        collectDiffSummary,
        runGates
      }
    });

    expect(GatedAgentLoopResultSchema.parse(output)).toEqual(output);
    expect(output).toEqual({
      status: "passed",
      attempts_exhausted: false,
      attempts: [
        {
          attempt: 1,
          phase: "initial",
          agent_output: { summary: "implemented" },
          validation: passedValidation,
          gate_results: [{ id: "review", type: "agent", passed: true }],
          diff_summary: { files: ["src/checkout.ts"] }
        }
      ],
      validation: passedValidation,
      final_validation: passedValidation,
      gates: [{ id: "review", type: "agent", passed: true }],
      result: {
        status: "passed",
        agent_output: { summary: "implemented" },
        diff_summary: { files: ["src/checkout.ts"] },
        review: { findings: [] }
      }
    });
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(runWorker).toHaveBeenCalledWith({
      cwd,
      prompt,
      attempt: 1,
      phase: "initial",
      previousValidation: undefined,
      previousError: undefined
    });
    expect(runValidation).toHaveBeenCalledTimes(1);
    expect(collectDiffSummary).toHaveBeenCalledTimes(1);
    expect(runGates).toHaveBeenCalledTimes(1);
  });

  it("repairs after a failed first attempt", async () => {
    const runWorker = vi
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
    const failedGate = {
      id: "review",
      type: "agent",
      passed: false,
      feedback: "fix the edge case"
    };
    const passedGate = { id: "review", type: "agent", passed: true };
    const runGates = vi
      .fn()
      .mockResolvedValueOnce({
        passed: false,
        results: [failedGate],
        outputs: { review: { findings: [{ summary: "fix the edge case" }] } }
      })
      .mockResolvedValueOnce({
        passed: true,
        results: [passedGate],
        outputs: { review: { findings: [] } }
      });

    const output = await runGatedAgentLoopStateMachine({
      cwd,
      prompt,
      repairAttempts: 1,
      dependencies: {
        runWorker,
        runValidation,
        collectDiffSummary,
        runGates
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
        gate_results: [failedGate],
        diff_summary: firstDiffSummary
      },
      {
        attempt: 2,
        phase: "repair",
        agent_output: { summary: "repair pass" },
        validation: passedValidation,
        gate_results: [passedGate],
        diff_summary: finalDiffSummary
      }
    ]);
    expect(output.result).toMatchObject({
      status: "passed",
      agent_output: { summary: "repair pass" },
      diff_summary: finalDiffSummary
    });
    expect(runWorker).toHaveBeenLastCalledWith({
      cwd,
      prompt,
      attempt: 2,
      phase: "repair",
      previousValidation: failedValidation,
      previousError: undefined,
      previousGates: [failedGate],
      diffSummary: firstDiffSummary
    });
    expect(collectDiffSummary).toHaveBeenCalledTimes(2);
  });

  it("returns failed artifacts when attempts are exhausted", async () => {
    const runWorker = vi.fn(async () => ({ summary: "not enough" }));
    const runValidation = vi.fn(async () => failedValidation);
    const collectDiffSummary = vi.fn(async () => ({
      files: ["src/partial.ts"]
    }));
    const failedGate = { id: "validation", type: "validation_commands", passed: false };
    const runGates = vi.fn(async () => ({
      passed: false,
      results: [failedGate]
    }));

    const output = await runGatedAgentLoopStateMachine({
      cwd,
      prompt,
      repairAttempts: 0,
      dependencies: {
        runWorker,
        runValidation,
        collectDiffSummary,
        runGates
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
          gate_results: [failedGate],
          diff_summary: { files: ["src/partial.ts"] }
        }
      ],
      validation: failedValidation,
      final_validation: failedValidation,
      gates: [failedGate],
      result: {
        status: "failed",
        agent_output: { summary: "not enough" },
        diff_summary: { files: ["src/partial.ts"] }
      }
    });
  });

  it("records an agent error and uses it for the repair attempt", async () => {
    const runWorker = vi
      .fn()
      .mockRejectedValueOnce(new Error("agent crashed"))
      .mockResolvedValueOnce({ summary: "recovered" });
    const runValidation = vi.fn(async () => passedValidation);
    const collectDiffSummary = vi.fn(async () => ({ files: [] }));
    const runGates = vi.fn(async () => ({ passed: true, results: [] }));

    const output = await runGatedAgentLoopStateMachine({
      cwd,
      prompt,
      repairAttempts: 1,
      dependencies: {
        runWorker,
        runValidation,
        collectDiffSummary,
        runGates
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
        gate_results: [],
        diff_summary: { files: [] }
      }
    ]);
    expect(runWorker).toHaveBeenLastCalledWith({
      cwd,
      prompt,
      attempt: 2,
      phase: "repair",
      previousValidation: undefined,
      previousError: { message: "agent crashed" },
      previousGates: undefined,
      diffSummary: { files: [] }
    });
  });

  it("throws a coded infrastructure error when the final agent attempt fails", async () => {
    const cause = new Error("agent crashed for good");
    const runWorker = vi.fn(async () => {
      throw cause;
    });
    const runValidation = vi.fn(async () => passedValidation);
    const collectDiffSummary = vi.fn(async () => ({ files: [] }));
    const runGates = vi.fn(async () => ({ passed: true, results: [] }));

    await expect(
      runGatedAgentLoopStateMachine({
        cwd,
        prompt,
        repairAttempts: 0,
        dependencies: {
          runWorker,
          runValidation,
          collectDiffSummary,
          runGates
        }
      })
    ).rejects.toMatchObject({
      code: "gated_agent_loop_infrastructure_failure",
      cause
    });

    expect(runValidation).not.toHaveBeenCalled();
    expect(collectDiffSummary).toHaveBeenCalledTimes(1);
  });

  it("keeps artifact mapping keys at the top level", async () => {
    const output = await runGatedAgentLoopStateMachine({
      cwd,
      prompt,
      repairAttempts: -1,
      dependencies: {
        runWorker: vi.fn(),
        runValidation: vi.fn(),
        collectDiffSummary: vi.fn(),
        runGates: vi.fn()
      }
    });

    expect(output).toMatchObject({
      attempts: [],
      attempts_exhausted: true,
      validation: { passed: false },
      final_validation: { passed: false },
      gates: [],
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
        "gates",
        "result"
      ])
    );
  });
});
