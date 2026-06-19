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
  attempts: AgentLoopAttempt[];
  validation: ValidationResult;
  result: {
    status: "passed" | "failed";
    attempts_exhausted: boolean;
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

function failedWithoutAttempt(): AgentLoopStateMachineOutput {
  return {
    status: "failed",
    attempts: [],
    validation: { passed: false },
    result: {
      status: "failed",
      attempts_exhausted: true
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
  let finalValidation: ValidationResult = { passed: false };
  let finalAgentOutput: unknown;
  let finalAgentError: AgentLoopAgentError | undefined;

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
        previousError
      });
    } catch (error) {
      const agentError = normalizeAgentError(error);

      attempts.push({
        attempt: attemptNumber,
        phase,
        agent_error: agentError
      });

      finalAgentError = agentError;
      previousError = agentError;
      previousValidation = undefined;
      continue;
    }

    const validation = await dependencies.runValidation();

    attempts.push({
      attempt: attemptNumber,
      phase,
      agent_output: agentOutput,
      validation
    });

    finalAgentOutput = agentOutput;
    finalAgentError = undefined;
    finalValidation = validation;
    previousValidation = validation;
    previousError = undefined;

    if (validation.passed) {
      const diffSummary = await dependencies.collectDiffSummary();

      return {
        status: "passed",
        attempts,
        validation,
        result: {
          status: "passed",
          attempts_exhausted: false,
          agent_output: agentOutput,
          diff_summary: diffSummary
        }
      };
    }
  }

  const diffSummary = await dependencies.collectDiffSummary();

  return {
    status: "failed",
    attempts,
    validation: finalValidation,
    result: {
      status: "failed",
      attempts_exhausted: true,
      ...(finalAgentOutput === undefined ? {} : { agent_output: finalAgentOutput }),
      ...(finalAgentError === undefined ? {} : { agent_error: finalAgentError }),
      diff_summary: diffSummary
    }
  };
}
