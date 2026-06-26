import jsonata from "jsonata";
import type { GateResult } from "./gated-agent-loop.js";

export type AgentGateExpression = {
  expression: string;
};

function codedError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function feedbackFromValidation(commands: unknown): string | undefined {
  if (!Array.isArray(commands) || commands.length === 0) {
    return undefined;
  }

  return JSON.stringify(commands);
}

async function evaluateJsonataExpression(
  gateId: string,
  purpose: "block_when" | "feedback",
  expression: string,
  output: unknown
): Promise<unknown> {
  try {
    return await jsonata(expression).evaluate(output);
  } catch (cause) {
    const error = codedError(
      `Gated agent loop ${purpose} expression failed for gate ${gateId}`,
      "gated_agent_loop_gate_expression_failed"
    );
    error.cause = cause;
    throw error;
  }
}

export async function gateResultFromAgentOutput({
  id,
  type,
  blockWhen,
  feedback,
  output,
  expressionRoot = output
}: {
  id: string;
  type: string;
  blockWhen: AgentGateExpression;
  feedback?: AgentGateExpression;
  output: unknown;
  expressionRoot?: unknown;
}): Promise<GateResult> {
  const blocks = await evaluateJsonataExpression(
    id,
    "block_when",
    blockWhen.expression,
    expressionRoot
  );

  if (typeof blocks !== "boolean") {
    throw codedError(
      `Gated agent loop block_when expression must return a boolean for gate ${id}`,
      "gated_agent_loop_gate_block_when_not_boolean"
    );
  }

  const passed = !blocks;
  const feedbackValue =
    passed || feedback === undefined
      ? undefined
      : await evaluateJsonataExpression(
          id,
          "feedback",
          feedback.expression,
          expressionRoot
        );

  return {
    id,
    type,
    passed,
    ...(passed || feedbackValue === undefined
      ? {}
      : { feedback: JSON.stringify(feedbackValue) }),
    output
  };
}
