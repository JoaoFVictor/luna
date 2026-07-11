import type { RouterDefinition } from "../../../core/router/router-definition.js";
import {
  STUDIO_ROUTING_TIMEOUT_MS,
  StudioRoutingSimulationRequestSchema,
  StudioRoutingSimulationSchema,
  type StudioRoutingSimulation
} from "../../contracts/input-routing.js";
import {
  isolatedStudioRoutingExecutor,
  type StudioRoutingExecution,
  type StudioRoutingExecutor
} from "./isolated-routing-executor.js";

export type StudioRoutingSimulationOptions = {
  readonly executor?: StudioRoutingExecutor;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

export type StudioRoutingSimulationPort = {
  readonly simulate: (
    request: unknown,
    definition: RouterDefinition,
    options?: StudioRoutingSimulationOptions
  ) => Promise<StudioRoutingSimulation>;
};

function validatedTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
    throw new Error("Studio routing timeout must be between 1 and 5000 ms");
  }
  return timeoutMs;
}

function failedSimulation(
  execution: Exclude<StudioRoutingExecution, { readonly kind: "simulation" }>
): StudioRoutingSimulation {
  const diagnostic = (() => {
    switch (execution.kind) {
      case "cancelled":
        return {
          code: "router_evaluation_cancelled" as const,
          message: "Routing evaluation was cancelled"
        };
      case "timeout":
        return {
          code: "router_evaluation_timeout" as const,
          message: "Routing evaluation timed out"
        };
      case "failed":
        return {
          code: "router_evaluation_failed" as const,
          message: "Routing evaluation failed"
        };
    }
  })();

  return StudioRoutingSimulationSchema.parse({
    status: "error",
    evaluations: [],
    matched_rule: null,
    target: null,
    diagnostics: [{ severity: "error", ...diagnostic }]
  });
}

export async function simulateStudioRouting(
  request: unknown,
  definition: RouterDefinition,
  options: StudioRoutingSimulationOptions = {}
): Promise<StudioRoutingSimulation> {
  const parsed = StudioRoutingSimulationRequestSchema.parse(request);
  const executor = options.executor ?? isolatedStudioRoutingExecutor;
  const signal = options.signal ?? new AbortController().signal;
  const timeoutMs = validatedTimeout(
    options.timeoutMs ?? STUDIO_ROUTING_TIMEOUT_MS
  );
  let execution: StudioRoutingExecution;
  try {
    execution = await executor.simulate({
      definition,
      invocation: parsed.invocation,
      signal,
      timeoutMs
    });
  } catch {
    execution = { kind: "failed" };
  }
  return execution.kind === "simulation"
    ? StudioRoutingSimulationSchema.parse(execution.simulation)
    : failedSimulation(execution);
}

export const isolatedStudioRoutingSimulationPort: StudioRoutingSimulationPort =
  Object.freeze({ simulate: simulateStudioRouting });
