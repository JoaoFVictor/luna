import type {
  AgentLoopAttempt,
  ValidationResult
} from "./types.js";

export type AgentLoopPhase = "initial" | "repair";

export type AgentLoopAgentError = {
  message: string;
  code?: string;
};

export type RunWritableAgentInput = {
  cwd: string;
  prompt: unknown;
  attempt: number;
  phase: AgentLoopPhase;
  previousValidation?: ValidationResult;
  previousError?: AgentLoopAgentError;
  diffSummary?: unknown;
};

export type RunAgentLoopStateMachineDependencies = {
  runWritableAgent: (input: RunWritableAgentInput) => Promise<unknown>;
  runValidation: () => Promise<ValidationResult>;
  collectDiffSummary: () => Promise<unknown>;
};

export type RunAgentLoopStateMachineInput = {
  cwd: string;
  prompt: unknown;
  repairAttempts: number;
  dependencies: RunAgentLoopStateMachineDependencies;
};

export type AgentLoopStateMachineOutput = {
  status: "passed" | "failed";
  attempts_exhausted: boolean;
  attempts: AgentLoopAttempt[];
  validation: ValidationResult;
  final_validation: ValidationResult;
  result: {
    status: "passed" | "failed";
    agent_output?: unknown;
    agent_error?: AgentLoopAgentError;
    diff_summary?: unknown;
  };
};

function normalizeAgentError(error: unknown): AgentLoopAgentError {
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

function agentLoopInfrastructureFailure(cause: unknown): Error & { code: string } {
  const error = new Error("Agent loop infrastructure failure", {
    cause
  }) as Error & { code: string; cause?: unknown };
  error.code = "agent_loop_infrastructure_failure";
  error.cause = cause;
  return error;
}

function failedWithoutAttempt(): AgentLoopStateMachineOutput {
  const finalValidation = { passed: false };

  return {
    status: "failed",
    attempts_exhausted: true,
    attempts: [],
    validation: finalValidation,
    final_validation: finalValidation,
    result: {
      status: "failed"
    }
  };
}

export async function runAgentLoopStateMachine({
  cwd,
  prompt,
  repairAttempts,
  dependencies
}: RunAgentLoopStateMachineInput): Promise<AgentLoopStateMachineOutput> {
  const maxAttempts = Math.max(0, Math.floor(repairAttempts) + 1);

  if (maxAttempts === 0) {
    return failedWithoutAttempt();
  }

  const attempts: AgentLoopAttempt[] = [];
  let previousValidation: ValidationResult | undefined;
  let previousError: AgentLoopAgentError | undefined;
  let previousDiffSummary: unknown;
  let finalValidation: ValidationResult = { passed: false };
  let finalAgentOutput: unknown;
  let finalDiffSummary: unknown;

  for (let index = 0; index < maxAttempts; index += 1) {
    const attemptNumber = index + 1;
    const phase: AgentLoopPhase = attemptNumber === 1 ? "initial" : "repair";

    let agentOutput: unknown;

    try {
      agentOutput = await dependencies.runWritableAgent({
        cwd,
        prompt,
        attempt: attemptNumber,
        phase,
        previousValidation,
        previousError,
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
        throw agentLoopInfrastructureFailure(error);
      }

      previousError = agentError;
      previousValidation = undefined;
      previousDiffSummary = diffSummary;
      continue;
    }

    const validation = await dependencies.runValidation();
    const diffSummary = await dependencies.collectDiffSummary();

    attempts.push({
      attempt: attemptNumber,
      phase,
      agent_output: agentOutput,
      validation,
      diff_summary: diffSummary
    });

    finalAgentOutput = agentOutput;
    finalValidation = validation;
    finalDiffSummary = diffSummary;
    previousValidation = validation;
    previousError = undefined;
    previousDiffSummary = diffSummary;

    if (validation.passed) {
      return {
        status: "passed",
        attempts_exhausted: false,
        attempts,
        validation,
        final_validation: validation,
        result: {
          status: "passed",
          agent_output: agentOutput,
          diff_summary: diffSummary
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
    result: {
      status: "failed",
      ...(finalAgentOutput === undefined ? {} : { agent_output: finalAgentOutput }),
      ...(finalDiffSummary === undefined ? {} : { diff_summary: finalDiffSummary })
    }
  };
}
