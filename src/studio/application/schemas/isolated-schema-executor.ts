import type {
  JsonSchemaMismatch,
  JsonSchemaPathSegment
} from "../../../core/capabilities/json-schema.js";
import type { JsonSchemaLike } from "../../../core/capabilities/json-schema-types.js";
import type { JsonValue } from "../../../core/json/value.js";
import { STUDIO_SCHEMA_DIAGNOSTICS_MAX } from "../../contracts/schema-validation.js";
import {
  runStudioIsolatedWorker,
  studioWorkerUrl
} from "../sandbox/isolated-worker.js";
// Worker entrypoints are URL-loaded at runtime; keep this edge visible to static tooling.
import type {} from "./schema-worker.js";

export type StudioSchemaExecution =
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed" }
  | {
      readonly kind: "invalid";
      readonly mismatches: readonly JsonSchemaMismatch[];
    }
  | { readonly kind: "timeout" }
  | { readonly kind: "valid" };

export type StudioSchemaExecutor = {
  readonly validate: (input: {
    readonly instance: JsonValue;
    readonly schema: JsonSchemaLike;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }) => Promise<StudioSchemaExecution>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPath(value: unknown): value is readonly JsonSchemaPathSegment[] {
  return (
    Array.isArray(value) &&
    value.every(
      (segment) =>
        typeof segment === "string" ||
        (Number.isSafeInteger(segment) && Number(segment) >= 0)
    )
  );
}

function isMismatch(value: unknown): value is JsonSchemaMismatch {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.keyword === "string" &&
    isPath(value.instancePath) &&
    isPath(value.schemaPath)
  );
}

function executionFromMessage(message: unknown): StudioSchemaExecution {
  if (!isRecord(message)) {
    return { kind: "failed" };
  }
  if (message.kind === "valid") {
    return { kind: "valid" };
  }
  if (
    message.kind === "invalid" &&
    Array.isArray(message.mismatches) &&
    message.mismatches.length > 0 &&
    message.mismatches.length <= STUDIO_SCHEMA_DIAGNOSTICS_MAX + 1 &&
    message.mismatches.every(isMismatch)
  ) {
    return { kind: "invalid", mismatches: message.mismatches };
  }
  return { kind: "failed" };
}

async function validateInWorker(input: {
  readonly instance: JsonValue;
  readonly schema: JsonSchemaLike;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}): Promise<StudioSchemaExecution> {
  const outcome = await runStudioIsolatedWorker({
    entry: studioWorkerUrl(import.meta.url, "schema-worker"),
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    workerData: {
      instance: input.instance,
      schema: input.schema,
      maxMismatches: STUDIO_SCHEMA_DIAGNOSTICS_MAX + 1
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

export const isolatedStudioSchemaExecutor: StudioSchemaExecutor = Object.freeze({
  validate: validateInWorker
});
