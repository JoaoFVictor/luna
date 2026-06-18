import { RouteTargetSchema, type RouteTarget, type RoutingConfig } from "./types.js";

type InvocationLike = Record<string, unknown>;

function errorWithCode(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;

  return error;
}

export function routeInvocation(
  invocation: InvocationLike,
  routingConfig: RoutingConfig
): RouteTarget {
  for (const route of routingConfig.routes) {
    const hasInputTarget = invocation.target !== undefined;

    if (
      route.when.has_target === true &&
      hasInputTarget &&
      route.use_target_from_input === true
    ) {
      return RouteTargetSchema.parse(invocation.target);
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
