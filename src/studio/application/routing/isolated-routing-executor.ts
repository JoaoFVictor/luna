import type { RouterDefinition } from "../../../core/router/router-definition.js";
import {
  StudioRoutingSimulationSchema,
  type StudioInvocation,
  type StudioRoutingSimulation
} from "../../contracts/input-routing.js";
import {
  runStudioIsolatedWorker,
  studioWorkerUrl
} from "../sandbox/isolated-worker.js";
// Worker entrypoints are URL-loaded at runtime; keep this edge visible to static tooling.
import type {} from "./routing-worker.js";

export type StudioRoutingExecution =
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed" }
  | {
      readonly kind: "simulation";
      readonly simulation: StudioRoutingSimulation;
    }
  | { readonly kind: "timeout" };

export type StudioRoutingExecutor = {
  readonly simulate: (input: {
    readonly definition: RouterDefinition;
    readonly invocation: StudioInvocation;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }) => Promise<StudioRoutingExecution>;
};

function executionFromMessage(message: unknown): StudioRoutingExecution {
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    return { kind: "failed" };
  }
  const candidate: { readonly kind?: unknown; readonly simulation?: unknown } =
    message;
  if (candidate.kind !== "simulation") {
    return { kind: "failed" };
  }
  const parsed = StudioRoutingSimulationSchema.safeParse(candidate.simulation);
  return parsed.success
    ? { kind: "simulation", simulation: parsed.data }
    : { kind: "failed" };
}

async function simulateInWorker(input: {
  readonly definition: RouterDefinition;
  readonly invocation: StudioInvocation;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}): Promise<StudioRoutingExecution> {
  const outcome = await runStudioIsolatedWorker({
    entry: studioWorkerUrl(import.meta.url, "routing-worker"),
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    workerData: {
      definition: input.definition,
      invocation: input.invocation
    }
  });
  switch (outcome.kind) {
    case "cancelled":
    case "timeout":
      return outcome;
    case "failed":
      return { kind: "failed" };
    case "message":
      return executionFromMessage(outcome.message);
  }
}

export const isolatedStudioRoutingExecutor: StudioRoutingExecutor =
  Object.freeze({ simulate: simulateInWorker });
