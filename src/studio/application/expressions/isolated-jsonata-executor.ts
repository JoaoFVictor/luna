import type { JsonValue } from "../../../core/json/value.js";
import type { StudioJsonLimits } from "../../contracts/bounded-json.js";
// Worker entrypoints are URL-loaded at runtime; keep this edge visible to static tooling.
import type {} from "./jsonata-worker.js";
import {
  runStudioIsolatedWorker,
  studioWorkerUrl
} from "../sandbox/isolated-worker.js";

export type StudioExpressionExecution =
  | { readonly kind: "cancelled" }
  | { readonly kind: "evaluation_failed" }
  | { readonly kind: "invalid_expression" }
  | { readonly kind: "invalid_result" }
  | { readonly kind: "timeout" }
  | { readonly kind: "undefined" }
  | { readonly kind: "value"; readonly value: unknown };

export type StudioExpressionExecutor = {
  readonly evaluate: (input: {
    readonly expression: string;
    readonly fixture: JsonValue;
    readonly resultLimits: StudioJsonLimits;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }) => Promise<StudioExpressionExecution>;
};

type WorkerResponse =
  | { readonly kind: "evaluation_failed" }
  | { readonly kind: "invalid_expression" }
  | { readonly kind: "invalid_result" }
  | { readonly kind: "undefined" }
  | { readonly kind: "value"; readonly value: unknown };

function workerResponse(value: unknown): WorkerResponse | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate: { readonly kind?: unknown; readonly value?: unknown } = value;
  switch (candidate.kind) {
    case "evaluation_failed":
    case "invalid_expression":
    case "invalid_result":
    case "undefined":
      return { kind: candidate.kind };
    case "value":
      return { kind: "value", value: candidate.value };
    default:
      return undefined;
  }
}

async function evaluateInWorker(input: {
  readonly expression: string;
  readonly fixture: JsonValue;
  readonly resultLimits: StudioJsonLimits;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}): Promise<StudioExpressionExecution> {
  if (input.signal.aborted) {
    return { kind: "cancelled" };
  }
  const outcome = await runStudioIsolatedWorker({
    entry: studioWorkerUrl(import.meta.url, "jsonata-worker"),
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    workerData: {
      expression: input.expression,
      fixture: input.fixture,
      resultLimits: input.resultLimits
    }
  });
  switch (outcome.kind) {
    case "cancelled":
    case "timeout":
      return outcome;
    case "failed":
      return { kind: "evaluation_failed" };
    case "message":
      return workerResponse(outcome.message) ?? { kind: "evaluation_failed" };
  }
}

export const isolatedStudioExpressionExecutor: StudioExpressionExecutor =
  Object.freeze({ evaluate: evaluateInWorker });
