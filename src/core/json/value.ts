export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonValueBudget = {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxKeyLength: number;
};

export type JsonValueBudgetViolation =
  | "alias_or_cycle"
  | "bytes"
  | "depth"
  | "entries"
  | "invalid_type"
  | "key_length"
  | "non_finite_number"
  | "non_plain_object";

type PendingJsonValue = {
  readonly depth: number;
  readonly value: unknown;
};

const UTF8_ENCODER = new TextEncoder();

function jsonValueError(path: string, reason: string): Error & { code: string } {
  const error = new Error(
    `Invalid JSON value at ${path}: ${reason}`
  ) as Error & { code: string };
  error.code = "artifact_json_value_invalid";

  return error;
}

export function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

export function jsonValueBudgetViolation(
  value: unknown,
  budget: JsonValueBudget
): JsonValueBudgetViolation | undefined {
  const pending: PendingJsonValue[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let entries = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    if (current.depth > budget.maxDepth) {
      return "depth";
    }
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) {
        return "non_finite_number";
      }
      continue;
    }
    if (typeof current.value !== "object") {
      return "invalid_type";
    }
    if (seen.has(current.value)) {
      return "alias_or_cycle";
    }
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      entries += current.value.length;
      for (const nested of current.value) {
        pending.push({ value: nested, depth: current.depth + 1 });
      }
    } else {
      if (!isPlainObject(current.value)) {
        return "non_plain_object";
      }
      const objectEntries = Object.entries(current.value);
      entries += objectEntries.length;
      for (const [key, nested] of objectEntries) {
        if (key.length > budget.maxKeyLength) {
          return "key_length";
        }
        pending.push({ value: nested, depth: current.depth + 1 });
      }
    }
    if (entries > budget.maxEntries) {
      return "entries";
    }
  }

  try {
    const serialized = JSON.stringify(value);
    if (
      serialized === undefined ||
      UTF8_ENCODER.encode(serialized).byteLength > budget.maxBytes
    ) {
      return "bytes";
    }
  } catch {
    return "invalid_type";
  }
  return undefined;
}

export function assertJsonValue(
  value: unknown,
  path = "$",
  seen = new Set<object>()
): asserts value is JsonValue {
  if (value === null) {
    return;
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw jsonValueError(path, "number must be finite");
      }
      return;
    case "undefined":
      throw jsonValueError(path, "undefined is not JSON");
    case "function":
      throw jsonValueError(path, "function is not JSON");
    case "symbol":
      throw jsonValueError(path, "symbol is not JSON");
    case "bigint":
      throw jsonValueError(path, "bigint is not JSON");
    case "object":
      break;
  }

  if (seen.has(value)) {
    throw jsonValueError(path, "cycle is not JSON");
  }

  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertJsonValue(item, `${path}[${index}]`, seen);
    });
    seen.delete(value);
    return;
  }

  if (!isPlainObject(value)) {
    throw jsonValueError(path, "object must be plain");
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    assertJsonValue(nestedValue, `${path}.${key}`, seen);
  }

  seen.delete(value);
}
