import { sanitizeForObservability } from "../../../core/observability/sanitize.js";
import { redactString } from "../../../core/security/redactor.js";

function redactOutputKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactOutputKeys);
  if (value === null || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  let redactedIndex = 0;
  for (const [key, nested] of Object.entries(value)) {
    const safeKey = redactString(key) === key
      ? key
      : `<redacted-${redactedIndex += 1}>`;
    Object.defineProperty(result, safeKey, {
      value: redactOutputKeys(nested),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return result;
}

/** Canonical best-effort redaction used by captured and manually edited outputs. */
export function reusableOutputSafety(value: unknown): {
  readonly value: unknown;
  readonly changed: boolean;
} {
  const safe = redactOutputKeys(sanitizeForObservability(value));
  return {
    value: safe,
    changed: JSON.stringify(safe) !== JSON.stringify(value)
  };
}
