import { parentPort, workerData } from "node:worker_threads";
import type { JsonSchemaMismatch } from "../../../core/capabilities/json-schema.js";
import type { JsonSchemaLike } from "../../../core/capabilities/json-schema-types.js";

type MatcherModule = Pick<
  typeof import("../../../core/capabilities/json-schema.js"),
  "jsonSchemaMismatches" | "matchesJsonSchema"
>;

function respond(message: unknown): void {
  parentPort?.postMessage(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matcherUrl(): URL {
  return new URL(
    import.meta.url.endsWith(".ts")
      ? "../../../core/capabilities/json-schema.ts"
      : "../../../core/capabilities/json-schema.js",
    import.meta.url
  );
}

if (
  !isRecord(workerData) ||
  !isRecord(workerData.schema) ||
  !Number.isSafeInteger(workerData.maxMismatches) ||
  Number(workerData.maxMismatches) < 1
) {
  respond({ kind: "failed" });
} else {
  try {
    const matcher = (await import(matcherUrl().href)) as MatcherModule;
    const schema = workerData.schema as JsonSchemaLike;
    if (matcher.matchesJsonSchema(schema, workerData.instance)) {
      respond({ kind: "valid" });
    } else {
      const mismatches: readonly JsonSchemaMismatch[] =
        matcher.jsonSchemaMismatches(schema, workerData.instance);
      respond({
        kind: "invalid",
        mismatches: mismatches.slice(0, Number(workerData.maxMismatches))
      });
    }
  } catch {
    respond({ kind: "failed" });
  }
}
