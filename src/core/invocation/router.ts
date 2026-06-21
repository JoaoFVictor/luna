import { z } from "zod";
import {
  RouteTargetSchema,
  type Invocation,
  type RouteTarget,
  type RoutingConfig
} from "./types.js";

function errorWithCode(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;

  return error;
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

function stringMatchesExactOrList(
  value: string | undefined,
  exact: string | undefined,
  list: string[] | undefined
): boolean {
  if (exact === undefined && list === undefined) {
    return true;
  }

  if (value === undefined) {
    return false;
  }

  return value === exact || list?.includes(value) === true;
}

export function routeInvocation(
  invocation: Invocation,
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
      return parseInputTarget(invocation.target);
    }

    const sourceMatches =
      route.when.source === undefined || route.when.source === invocation.source;
    const eventMatches = stringMatchesExactOrList(
      invocation.event,
      route.when.event,
      route.when.event_in
    );
    const actionMatches = stringMatchesExactOrList(
      invocation.action,
      route.when.action,
      route.when.action_in
    );

    if (
      sourceMatches &&
      eventMatches &&
      actionMatches &&
      route.target !== undefined
    ) {
      return route.target;
    }
  }

  throw errorWithCode("No route matched invocation", "no_route_matched");
}
