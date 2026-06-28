import { redactValue } from "../security/redactor.js";
import type { JsonValue } from "../json/value.js";
import type { JsonObject } from "../runtime/json.js";

const OBSERVABILITY_SENSITIVE_KEYS = [
  "prompt",
  "systemPrompt",
  "prompt_text",
  "provider_payload",
  "providerPayload",
  "provider.payload"
];

function errorToRecord(error: Error, seen: WeakSet<object>): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(error.cause === undefined
      ? {}
      : { cause: normalizeForJson(error.cause, seen) })
  };
}

function normalizeForJson(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Error) {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    return errorToRecord(value, seen);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    return value.map((item) => normalizeForJson(item, seen));
  }

  if (value !== null && typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);

    const normalized: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      normalized[key] = normalizeForJson(nestedValue, seen);
    }

    return normalized;
  }

  return value;
}

export function sanitizeForObservability(value: unknown): unknown {
  return redactValue(normalizeForJson(value, new WeakSet<object>()), {
    extraSensitiveKeys: OBSERVABILITY_SENSITIVE_KEYS
  });
}

export function sanitizeAttributes(
  attributes: Record<string, unknown> | undefined
): Record<string, unknown> {
  return (sanitizeForObservability(attributes ?? {}) ?? {}) as Record<
    string,
    unknown
  >;
}

function jsonValueFromSanitized(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => jsonValueFromSanitized(item) ?? null);
  }

  if (typeof value === "object") {
    const object: JsonObject = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      const jsonValue = jsonValueFromSanitized(nestedValue);

      if (jsonValue !== undefined) {
        object[key] = jsonValue;
      }
    }

    return object;
  }

  return String(value);
}

export function sanitizeJsonObject(
  attributes: Record<string, unknown> | undefined
): JsonObject {
  const value = jsonValueFromSanitized(sanitizeAttributes(attributes));

  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
