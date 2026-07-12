import { parentPort, workerData } from "node:worker_threads";
import jsonata from "jsonata";

type JsonValueModule = Pick<
  typeof import("../../../core/json/value.js"),
  "jsonValueBudgetViolation"
>;

function respond(message: unknown): void {
  parentPort?.postMessage(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validWorkerData(
  value: unknown
): value is {
  readonly expression: string;
  readonly fixture: unknown;
  readonly resultLimits: {
    readonly maxBytes: number;
    readonly maxDepth: number;
    readonly maxEntries: number;
    readonly maxKeyLength: number;
  };
} {
  if (!isRecord(value) || typeof value.expression !== "string") {
    return false;
  }
  const limits = value.resultLimits;
  return (
    isRecord(limits) &&
    [
      limits.maxBytes,
      limits.maxDepth,
      limits.maxEntries,
      limits.maxKeyLength
    ].every((limit) => Number.isSafeInteger(limit) && Number(limit) > 0)
  );
}

function jsonValueModuleUrl(): URL {
  return new URL(
    import.meta.url.endsWith(".ts")
      ? "../../../core/json/value.ts"
      : "../../../core/json/value.js",
    import.meta.url
  );
}

if (!validWorkerData(workerData)) {
  respond({ kind: "evaluation_failed" });
} else {
  let expression;
  try {
    expression = jsonata(workerData.expression);
  } catch {
    respond({ kind: "invalid_expression" });
  }

  if (expression !== undefined) {
    try {
      const jsonValues = (await import(
        jsonValueModuleUrl().href
      )) as JsonValueModule;
      const value = await expression.evaluate(workerData.fixture);
      if (value === undefined) {
        respond({ kind: "undefined" });
      } else if (
        jsonValues.jsonValueBudgetViolation(
          value,
          workerData.resultLimits
        ) !== undefined
      ) {
        respond({ kind: "invalid_result" });
      } else {
        respond({ kind: "value", value });
      }
    } catch {
      respond({ kind: "evaluation_failed" });
    }
  }
}
