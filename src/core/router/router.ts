import jsonata from "jsonata";
import { z } from "zod";
import {
  RouteTargetSchema,
  type Invocation,
  type RouteTarget
} from "./invocation.js";
import type { RouterDefinition, RouterRule } from "./router-definition.js";

export type RouterErrorCode =
  | "router_expression_failed"
  | "router_invalid_target"
  | "router_no_match";

export type RouterRuleEvaluation =
  | {
      readonly outcome: "boolean";
      readonly ruleIndex: number;
      readonly ruleId: string;
      readonly expressionPath: string;
      readonly result: boolean;
    }
  | {
      readonly outcome: "error";
      readonly ruleIndex: number;
      readonly ruleId: string;
      readonly expressionPath: string;
      readonly error: RouterError;
    };

export type RouteInvocationDecision =
  | {
      readonly outcome: "matched";
      readonly target: RouteTarget;
      readonly matchedRule: {
        readonly ruleIndex: number;
        readonly ruleId: string;
      };
      readonly evaluations: readonly RouterRuleEvaluation[];
    }
  | {
      readonly outcome: "error";
      readonly error: RouterError;
      readonly matchedRule?: {
        readonly ruleIndex: number;
        readonly ruleId: string;
      };
      readonly evaluations: readonly RouterRuleEvaluation[];
    };

export class RouterError extends Error {
  readonly code: RouterErrorCode;
  readonly path?: string;

  constructor(code: RouterErrorCode, message: string, path?: string) {
    super(message);
    this.name = "RouterError";
    this.code = code;
    this.path = path;
  }
}

function routerError(
  code: RouterErrorCode,
  message: string,
  path?: string
): RouterError {
  return new RouterError(code, message, path);
}

export function parseWorkflowTarget(value: string): RouteTarget {
  const prefix = "workflow:";
  const candidate: unknown = value.startsWith(prefix)
    ? { type: "workflow", id: value.slice(prefix.length) }
    : value;
  const result = RouteTargetSchema.safeParse(candidate);

  if (!result.success) {
    throw routerError(
      "router_invalid_target",
      `Invalid workflow target "${value}". Expected workflow:<id>.`
    );
  }

  return result.data;
}

function parseTargetValue(value: unknown, path: string): RouteTarget {
  try {
    return typeof value === "string"
      ? parseWorkflowTarget(value)
      : RouteTargetSchema.parse(value);
  } catch (cause) {
    if (cause instanceof z.ZodError || cause instanceof RouterError) {
      throw routerError(
        "router_invalid_target",
        `Invalid router target at ${path}.`,
        path
      );
    }

    throw cause;
  }
}

async function evaluateExpression(
  rule: RouterRule,
  invocation: Invocation,
  path: string
): Promise<unknown> {
  try {
    return await jsonata(rule.when.expression).evaluate({ invocation });
  } catch {
    throw routerError(
      "router_expression_failed",
      `Router expression failed at ${path}.`,
      path
    );
  }
}

export async function decideInvocationRoute(
  invocation: Invocation,
  router: RouterDefinition
): Promise<RouteInvocationDecision> {
  const evaluations: RouterRuleEvaluation[] = [];

  for (const [index, rule] of router.rules.entries()) {
    const expressionPath = `$.rules[${index}].when.expression`;
    let evaluated: unknown;

    try {
      evaluated = await evaluateExpression(rule, invocation, expressionPath);
    } catch (cause) {
      if (cause instanceof RouterError) {
        evaluations.push({
          outcome: "error",
          ruleIndex: index,
          ruleId: rule.id,
          expressionPath,
          error: cause
        });
        return {
          outcome: "error",
          error: cause,
          evaluations
        };
      }
      throw cause;
    }

    const matched = evaluated === true;
    evaluations.push({
      outcome: "boolean",
      ruleIndex: index,
      ruleId: rule.id,
      expressionPath,
      result: matched
    });

    if (!matched) {
      continue;
    }

    const targetPath = `$.rules[${index}].target`;
    try {
      return {
        outcome: "matched",
        target: parseTargetValue(
          rule.target === "$.invocation.target" ? invocation.target : rule.target,
          targetPath
        ),
        matchedRule: { ruleIndex: index, ruleId: rule.id },
        evaluations
      };
    } catch (cause) {
      if (cause instanceof RouterError) {
        return {
          outcome: "error",
          error: cause,
          matchedRule: { ruleIndex: index, ruleId: rule.id },
          evaluations
        };
      }
      throw cause;
    }
  }

  return {
    outcome: "error",
    error: routerError("router_no_match", "No router rule matched invocation."),
    evaluations
  };
}

export async function routeInvocation(
  invocation: Invocation,
  router: RouterDefinition
): Promise<RouteTarget> {
  const decision = await decideInvocationRoute(invocation, router);
  if (decision.outcome === "error") {
    throw decision.error;
  }

  return decision.target;
}
