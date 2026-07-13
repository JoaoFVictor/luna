import { describe, expect, it, vi } from "vitest";
import { runGatedAgentLoopStateMachine } from "../../../src/capabilities/quality-gates/gated-agent-loop.js";
import type { ValidationResult } from "../../../src/capabilities/validation/command-runner.js";

const passedValidation: ValidationResult = { passed: true };
const failedValidation: ValidationResult = { passed: false };
const cwd = "/repo/worktree";
const prompt = { task: "ABC-123" };

describe("gated agent loop runner", () => {
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
      diff_summary: finalDiffSummary,
      review: { findings: [] }
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

  it("returns acceptance feedback to the worker until a later attempt is accepted", async () => {
    const runWorker = vi
      .fn()
      .mockResolvedValueOnce({ summary: "initial implementation" })
      .mockResolvedValueOnce({ summary: "acceptance repair" });
    const runValidation = vi.fn(async () => passedValidation);
    const collectDiffSummary = vi
      .fn()
      .mockResolvedValueOnce({ files: ["src/initial.ts"] })
      .mockResolvedValueOnce({ files: ["src/repaired.ts"] });
    const rejectedAcceptance = {
      id: "acceptance",
      type: "quality-gates.agent_review",
      passed: false,
      feedback: "Preserve the touch-device submit control.",
      output: {
        status: "rejected",
        summary: "The desktop rule also hides the control on hybrid devices.",
        blocking_reasons: ["Hybrid touch devices still need the submit control."],
        recommended_action: "repair"
      }
    };
    const acceptedAcceptance = {
      id: "acceptance",
      type: "quality-gates.agent_review",
      passed: true,
      output: {
        status: "accepted",
        summary: "Desktop and hybrid-device behavior now match the task.",
        blocking_reasons: [],
        recommended_action: "continue"
      }
    };
    const runGates = vi
      .fn()
      .mockResolvedValueOnce({
        passed: false,
        results: [rejectedAcceptance],
        outputs: { acceptance: rejectedAcceptance.output }
      })
      .mockResolvedValueOnce({
        passed: true,
        results: [acceptedAcceptance],
        outputs: { acceptance: acceptedAcceptance.output }
      });

    const output = await runGatedAgentLoopStateMachine({
      cwd,
      prompt,
      repairAttempts: 5,
      dependencies: {
        runWorker,
        runValidation,
        collectDiffSummary,
        runGates
      }
    });

    expect(output).toMatchObject({
      status: "passed",
      attempts_exhausted: false,
      attempts: [
        { attempt: 1, phase: "initial", gate_results: [rejectedAcceptance] },
        { attempt: 2, phase: "repair", gate_results: [acceptedAcceptance] }
      ],
      result: {
        status: "passed",
        acceptance: acceptedAcceptance.output
      }
    });
    expect(runWorker).toHaveBeenNthCalledWith(2, {
      cwd,
      prompt,
      attempt: 2,
      phase: "repair",
      previousValidation: passedValidation,
      previousError: undefined,
      previousGates: [rejectedAcceptance],
      diffSummary: { files: ["src/initial.ts"] }
    });
    expect(runGates).toHaveBeenCalledTimes(2);
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

  it("persists attempt evidence returned by the gate phase", async () => {
    const events: string[] = [];
    const runWorker = vi
      .fn()
      .mockImplementationOnce(async () => {
        events.push("worker:1");
        return { summary: "first" };
      })
      .mockImplementationOnce(async () => {
        events.push("worker:2");
        return { summary: "repaired" };
      });
    const runValidation = vi.fn(async () => passedValidation);
    const collectDiffSummary = vi
      .fn()
      .mockImplementationOnce(async () => {
        events.push("diff:1");
        return { files: ["src/first.ts"] };
      })
      .mockImplementationOnce(async () => {
        events.push("diff:2");
        return { files: ["src/repaired.ts"] };
      });
    const runGates = vi
      .fn()
      .mockImplementationOnce(async (input) => {
        events.push("gates:1");
        return {
          passed: false,
          results: [],
          evidence: {
            repository_context: {
              attempt: input.attempt,
              diff: input.diffSummary
            }
          }
        };
      })
      .mockImplementationOnce(async (input) => {
        events.push("gates:2");
        return {
          passed: true,
          results: [],
          evidence: {
            repository_context: {
              attempt: input.attempt,
              diff: input.diffSummary
            }
          }
        };
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

    expect(events).toEqual([
      "worker:1",
      "diff:1",
      "gates:1",
      "worker:2",
      "diff:2",
      "gates:2"
    ]);
    expect(output.attempts).toMatchObject([
      {
        attempt: 1,
        evidence: {
          repository_context: {
            attempt: 1,
            diff: { files: ["src/first.ts"] }
          }
        }
      },
      {
        attempt: 2,
        evidence: {
          repository_context: {
            attempt: 2,
            diff: { files: ["src/repaired.ts"] }
          }
        }
      }
    ]);
    expect(output.result.evidence).toEqual({
      repository_context: {
        attempt: 2,
        diff: { files: ["src/repaired.ts"] }
      }
    });
  });

  it("returns failed artifacts when the final agent attempt fails", async () => {
    const cause = new Error("agent crashed for good");
    const runWorker = vi.fn(async () => {
      throw cause;
    });
    const runValidation = vi.fn(async () => passedValidation);
    const collectDiffSummary = vi.fn(async () => ({ files: [] }));
    const runGates = vi.fn(async () => ({ passed: true, results: [] }));

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

    expect(output).toMatchObject({
      status: "failed",
      attempts_exhausted: true,
      attempts: [
        {
          attempt: 1,
          phase: "initial",
          agent_error: { message: "agent crashed for good" },
          diff_summary: { files: [] }
        }
      ],
      result: {
        status: "failed",
        agent_error: { message: "agent crashed for good" },
        diff_summary: { files: [] }
      }
    });
    expect(runValidation).not.toHaveBeenCalled();
    expect(collectDiffSummary).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid repair attempt bounds", async () => {
    const dependencies = {
      runWorker: vi.fn(),
      runValidation: vi.fn(),
      collectDiffSummary: vi.fn(),
      runGates: vi.fn()
    };

    await expect(
      runGatedAgentLoopStateMachine({
        cwd,
        prompt,
        repairAttempts: -1,
        dependencies
      })
    ).rejects.toMatchObject({ code: "gated_agent_loop_repair_attempts_invalid" });

    expect(dependencies.runWorker).not.toHaveBeenCalled();
  });

  it("rejects gate outputs that collide with reserved result artifact keys", async () => {
    await expect(
      runGatedAgentLoopStateMachine({
        cwd,
        prompt,
        repairAttempts: 0,
        dependencies: {
          runWorker: vi.fn(async () => ({ summary: "implemented" })),
          runValidation: vi.fn(async () => passedValidation),
          collectDiffSummary: vi.fn(async () => ({ files: [] })),
          runGates: vi.fn(async () => ({
            passed: true,
            results: [{ id: "review", type: "agent", passed: true }],
            outputs: { status: "overwritten" }
          }))
        }
      })
    ).rejects.toMatchObject({ code: "gated_agent_loop_artifact_source_invalid" });
  });
});
