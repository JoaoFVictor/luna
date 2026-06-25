import { Buffer } from "node:buffer";
import {
  assertJsonValue,
  isPlainObject,
  type JsonValue
} from "../json/value.js";
import { runtimeError } from "./errors.js";

export type { JsonValue } from "../json/value.js";

export type JsonObject = { [key: string]: JsonValue };

export type CheckpointSizeOptions = {
  maxBytes: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : String(error);
}

function invalidCheckpointJson(path: string, cause?: unknown): never {
  throw runtimeError(
    `Invalid checkpoint JSON at ${path}: ${errorMessage(cause)}`,
    "runtime_invalid_json",
    {
      cause,
      details: { path }
    }
  );
}

export function assertCheckpointJsonValue(
  value: unknown,
  path = "$"
): asserts value is JsonValue {
  try {
    assertJsonValue(value, path);
  } catch (cause) {
    invalidCheckpointJson(path, cause);
  }
}

export function assertCheckpointJsonObject(
  value: unknown,
  path = "$"
): asserts value is JsonObject {
  assertCheckpointJsonValue(value, path);

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidCheckpointJson(
      path,
      new Error(`Invalid JSON value at ${path}: value must be a JSON object`)
    );
  }
}

export function isCheckpointPlainObject(
  value: unknown
): value is JsonObject {
  return typeof value === "object" && value !== null && isPlainObject(value);
}

export function checkpointJsonByteSize(value: unknown): number {
  assertCheckpointJsonValue(value);

  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function assertCheckpointJsonSize(
  value: unknown,
  { maxBytes }: CheckpointSizeOptions
): void {
  const sizeBytes = checkpointJsonByteSize(value);

  if (sizeBytes > maxBytes) {
    throw runtimeError(
      `Checkpoint state is too large: ${sizeBytes} bytes exceeds ${maxBytes} bytes`,
      "runtime_checkpoint_too_large",
      {
        details: {
          size_bytes: sizeBytes,
          max_bytes: maxBytes
        }
      }
    );
  }
}
