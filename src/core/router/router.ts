import jsonata from "jsonata";
import { z } from "zod";
import {
  RouteTargetSchema,
  type Invocation,
  type RouteTarget
} from "./invocation.js";
import type { RouterDefinition, RouterRule } from "./router-definition.js";

type RouterErrorCode =
  | "router_expression_failed"
  | "router_invalid_target"
  | "router_no_match";

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
  } catch (cause) {
    throw routerError(
      "router_expression_failed",
      cause instanceof Error ? cause.message : `Router expression failed at ${path}.`,
      path
    );
  }
}

export async function routeInvocation(
  invocation: Invocation,
  router: RouterDefinition
): Promise<RouteTarget> {
  for (const [index, rule] of router.rules.entries()) {
    const expressionPath = `$.rules[${index}].when.expression`;
    const matched = await evaluateExpression(rule, invocation, expressionPath);

    if (matched !== true) {
      continue;
    }

    const targetPath = `$.rules[${index}].target`;
    return parseTargetValue(
      rule.target === "$.invocation.target" ? invocation.target : rule.target,
      targetPath
    );
  }

  throw routerError("router_no_match", "No router rule matched invocation.");
}
