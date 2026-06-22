import type { GatedAgentLoopAttempt } from "../agent-runtime/contracts.js";
import type { ValidationResult } from "../validation/runner.js";

export type GatedAgentLoopPhase = "initial" | "repair";

export type GatedAgentError = {
  message: string;
  code?: string;
};

export type GateResult = {
  id: string;
  type: string;
  passed: boolean;
  feedback?: string;
  output?: unknown;
};

export type RunGatedWorkerInput = {
  cwd: string;
  prompt: unknown;
  attempt: number;
  phase: GatedAgentLoopPhase;
  previousValidation?: ValidationResult;
  previousError?: GatedAgentError;
  previousGates?: GateResult[];
  diffSummary?: unknown;
};

export type RunGatesInput = {
  attempt: number;
  phase: GatedAgentLoopPhase;
  workerOutput: unknown;
  validation: ValidationResult;
  diffSummary: unknown;
};

export type RunGatesOutput = {
  passed: boolean;
  results: GateResult[];
  outputs?: Record<string, unknown>;
};

export type RunGatedAgentLoopDependencies = {
  runWorker: (input: RunGatedWorkerInput) => Promise<unknown>;
  runValidation: () => Promise<ValidationResult>;
  collectDiffSummary: () => Promise<unknown>;
  runGates: (input: RunGatesInput) => Promise<RunGatesOutput>;
};

export type RunGatedAgentLoopInput = {
  cwd: string;
  prompt: unknown;
  repairAttempts: number;
  dependencies: RunGatedAgentLoopDependencies;
};

export type GatedAgentLoopOutput = {
  status: "passed" | "failed";
  attempts_exhausted: boolean;
  attempts: GatedAgentLoopAttempt[];
  validation: ValidationResult;
  final_validation: ValidationResult;
  gates: GateResult[];
  result: {
    status: "passed" | "failed";
    agent_output?: unknown;
    agent_error?: GatedAgentError;
    diff_summary?: unknown;
  } & Record<string, unknown>;
};

function normalizeAgentError(error: unknown): GatedAgentError {
  if (error instanceof Error) {
    const errorWithCode = error as Error & { code?: unknown };
    const code =
      typeof errorWithCode.code === "string" ? errorWithCode.code : undefined;

    return {
      message: error.message || "Unknown agent error",
      ...(code === undefined ? {} : { code })
    };
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.length > 0
  ) {
    const code =
      "code" in error && typeof error.code === "string" ? error.code : undefined;

    return {
      message: error.message,
      ...(code === undefined ? {} : { code })
    };
  }

  return { message: String(error || "Unknown agent error") };
}

function gatedLoopInfrastructureFailure(cause: unknown): Error & { code: string } {
  const error = new Error("Gated agent loop infrastructure failure", {
    cause
  }) as Error & { code: string; cause?: unknown };
  error.code = "gated_agent_loop_infrastructure_failure";
  error.cause = cause;
  return error;
}

function failedWithoutAttempt(): GatedAgentLoopOutput {
  const finalValidation = { passed: false };

  return {
    status: "failed",
    attempts_exhausted: true,
    attempts: [],
    validation: finalValidation,
    final_validation: finalValidation,
    gates: [],
    result: {
      status: "failed"
    }
  };
}

export async function runGatedAgentLoopStateMachine({
  cwd,
  prompt,
  repairAttempts,
  dependencies
}: RunGatedAgentLoopInput): Promise<GatedAgentLoopOutput> {
  const maxAttempts = Math.max(0, Math.floor(repairAttempts) + 1);

  if (maxAttempts === 0) {
    return failedWithoutAttempt();
  }

  const attempts: GatedAgentLoopAttempt[] = [];
  let previousValidation: ValidationResult | undefined;
  let previousError: GatedAgentError | undefined;
  let previousGates: GateResult[] | undefined;
  let previousDiffSummary: unknown;
  let finalValidation: ValidationResult = { passed: false };
  let finalAgentOutput: unknown;
  let finalDiffSummary: unknown;
  let finalGateResults: GateResult[] = [];
  let finalGateOutputs: Record<string, unknown> = {};

  for (let index = 0; index < maxAttempts; index += 1) {
    const attemptNumber = index + 1;
    const phase: GatedAgentLoopPhase =
      attemptNumber === 1 ? "initial" : "repair";

    let agentOutput: unknown;

    try {
      agentOutput = await dependencies.runWorker({
        cwd,
        prompt,
        attempt: attemptNumber,
        phase,
        previousValidation,
        previousError,
        previousGates,
        diffSummary: previousDiffSummary
      });
    } catch (error) {
      const agentError = normalizeAgentError(error);
      const diffSummary = await dependencies.collectDiffSummary();

      attempts.push({
        attempt: attemptNumber,
        phase,
        agent_error: agentError,
        diff_summary: diffSummary
      });

      if (attemptNumber >= maxAttempts) {
        throw gatedLoopInfrastructureFailure(error);
      }

      previousError = agentError;
      previousValidation = undefined;
      previousGates = undefined;
      previousDiffSummary = diffSummary;
      continue;
    }

    const validation = await dependencies.runValidation();
    const diffSummary = await dependencies.collectDiffSummary();
    const gates = await dependencies.runGates({
      attempt: attemptNumber,
      phase,
      workerOutput: agentOutput,
      validation,
      diffSummary
    });

    attempts.push({
      attempt: attemptNumber,
      phase,
      agent_output: agentOutput,
      validation,
      gate_results: gates.results,
      diff_summary: diffSummary
    });

    finalAgentOutput = agentOutput;
    finalValidation = validation;
    finalDiffSummary = diffSummary;
    finalGateResults = gates.results;
    finalGateOutputs = gates.outputs ?? {};
    previousValidation = validation;
    previousError = undefined;
    previousGates = gates.results;
    previousDiffSummary = diffSummary;

    if (validation.passed && gates.passed) {
      return {
        status: "passed",
        attempts_exhausted: false,
        attempts,
        validation,
        final_validation: validation,
        gates: gates.results,
        result: {
          status: "passed",
          agent_output: agentOutput,
          diff_summary: diffSummary,
          ...finalGateOutputs
        }
      };
    }
  }

  return {
    status: "failed",
    attempts_exhausted: true,
    attempts,
    validation: finalValidation,
    final_validation: finalValidation,
    gates: finalGateResults,
    result: {
      status: "failed",
      ...(finalAgentOutput === undefined ? {} : { agent_output: finalAgentOutput }),
      ...(finalDiffSummary === undefined ? {} : { diff_summary: finalDiffSummary }),
      ...finalGateOutputs
    }
  };
}
