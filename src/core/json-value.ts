export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

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
