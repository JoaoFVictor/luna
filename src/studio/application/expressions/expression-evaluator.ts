import {
  STUDIO_EXPRESSION_RESULT_LIMITS,
  STUDIO_EXPRESSION_TIMEOUT_MS,
  StudioExpressionEvaluationRequestSchema,
  StudioExpressionEvaluationSchema,
  type StudioExpressionDiagnostic,
  type StudioExpressionEvaluation,
  type StudioExpressionEvaluationRequest
} from "../../contracts/expression-evaluation.js";
import {
  isolatedStudioExpressionExecutor,
  type StudioExpressionExecution,
  type StudioExpressionExecutor
} from "./isolated-jsonata-executor.js";

export class StudioExpressionRequestError extends Error {
  readonly code = "studio_expression_request_invalid" as const;

  constructor() {
    super("The Studio expression request is invalid");
    this.name = "StudioExpressionRequestError";
  }
}

export type StudioExpressionService = {
  readonly evaluate: (
    request: StudioExpressionEvaluationRequest,
    signal: AbortSignal
  ) => Promise<StudioExpressionEvaluation>;
};

function diagnostic(
  execution: Exclude<StudioExpressionExecution, { readonly kind: "value" } | { readonly kind: "undefined" }>
): StudioExpressionDiagnostic {
  switch (execution.kind) {
    case "cancelled":
      return {
        severity: "error",
        code: "expression_cancelled",
        message: "Expression evaluation was cancelled",
        expression_path: "$.expression"
      };
    case "invalid_expression":
      return {
        severity: "error",
        code: "expression_invalid",
        message: "The expression is not valid JSONata",
        expression_path: "$.expression"
      };
    case "invalid_result":
      return {
        severity: "error",
        code: "expression_result_invalid",
        message: "The expression result is not a bounded JSON value",
        expression_path: "$.expression"
      };
    case "timeout":
      return {
        severity: "error",
        code: "expression_timeout",
        message: "Expression evaluation timed out",
        expression_path: "$.expression"
      };
    case "evaluation_failed":
      return {
        severity: "error",
        code: "expression_evaluation_failed",
        message: "Expression evaluation failed",
        expression_path: "$.expression"
      };
  }
}

function failedEvaluation(
  execution: Exclude<StudioExpressionExecution, { readonly kind: "value" } | { readonly kind: "undefined" }>
): StudioExpressionEvaluation {
  return StudioExpressionEvaluationSchema.parse({
    status: "error",
    result: null,
    diagnostics: [diagnostic(execution)]
  });
}

function validatedTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
    throw new Error("Studio expression timeout must be between 1 and 5000 ms");
  }
  return timeoutMs;
}

export function createStudioExpressionService(
  options: {
    readonly executor?: StudioExpressionExecutor;
    readonly timeoutMs?: number;
  } = {}
): StudioExpressionService {
  const executor = options.executor ?? isolatedStudioExpressionExecutor;
  const timeoutMs = validatedTimeout(
    options.timeoutMs ?? STUDIO_EXPRESSION_TIMEOUT_MS
  );

  return Object.freeze({
    async evaluate(request, signal) {
      const parsed = StudioExpressionEvaluationRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new StudioExpressionRequestError();
      }

      let execution: StudioExpressionExecution;
      try {
        execution = await executor.evaluate({
          expression: parsed.data.expression,
          fixture: parsed.data.fixture,
          resultLimits: STUDIO_EXPRESSION_RESULT_LIMITS,
          signal,
          timeoutMs
        });
      } catch {
        execution = { kind: "evaluation_failed" };
      }

      if (execution.kind === "undefined") {
        return StudioExpressionEvaluationSchema.parse({
          status: "evaluated",
          result: { kind: "undefined" },
          diagnostics: []
        });
      }
      if (execution.kind !== "value") {
        return failedEvaluation(execution);
      }

      const result = StudioExpressionEvaluationSchema.safeParse({
        status: "evaluated",
        result: { kind: "json", value: execution.value },
        diagnostics: []
      });
      return result.success
        ? result.data
        : failedEvaluation({ kind: "invalid_result" });
    }
  });
}
