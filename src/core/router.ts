import { z } from "zod";
import {
  RouteTargetSchema,
  type RouteTarget,
  type RoutingConfig
} from "./types.js";

type InvocationLike = Record<string, unknown>;

function errorWithCode(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;

  return error;
}

function hasNormalizedRoutingShape(invocation: InvocationLike): boolean {
  return (
    typeof invocation.source === "string" &&
    invocation.source !== "" &&
    typeof invocation.event === "string" &&
    invocation.event !== ""
  );
}

function parseInputTarget(target: unknown): RouteTarget {
  try {
    return RouteTargetSchema.parse(target);
  } catch (cause) {
    if (cause instanceof z.ZodError) {
      throw errorWithCode("Invalid invocation target", "invalid_target");
    }

    throw cause;
  }
}

export function routeInvocation(
  invocation: InvocationLike,
  routingConfig: RoutingConfig
): RouteTarget {
  for (const route of routingConfig.routes) {
    const hasInputTarget =
      typeof invocation.target === "object" &&
      invocation.target !== null &&
      !Array.isArray(invocation.target);

    if (
      route.when.has_target === true &&
      hasInputTarget &&
      route.use_target_from_input === true
    ) {
      if (!hasNormalizedRoutingShape(invocation)) {
        throw errorWithCode(
          "Invalid invocation for routing",
          "invalid_invocation"
        );
      }

      return parseInputTarget(invocation.target);
    }

    const sourceMatches =
      route.when.source === undefined || route.when.source === invocation.source;
    const event = invocation.event;
    const eventMatches =
      route.when.event_in === undefined ||
      (typeof event === "string" && route.when.event_in.includes(event));

    if (sourceMatches && eventMatches && route.target !== undefined) {
      return route.target;
    }
  }

  throw errorWithCode("No route matched invocation", "no_route_matched");
}
