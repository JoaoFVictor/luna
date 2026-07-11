import {
  isCheckpointPlainObject,
  stableJson,
  type JsonObject,
  type JsonValue
} from "../../core/runtime/json.js";
import type {
  RuntimeArtifactRef,
  RuntimeInterruptRef
} from "../../core/runtime/state.js";

export type RuntimeReference = RuntimeArtifactRef | RuntimeInterruptRef;

export function runtimeReferenceKey(reference: RuntimeReference): string {
  return `${reference.id}\u0000${reference.uri}\u0000${reference.node_id ?? ""}`;
}

export function encodeRuntimeReference(reference: RuntimeReference): JsonObject {
  return {
    id: reference.id,
    uri: reference.uri,
    ...(reference.node_id === undefined
      ? {}
      : { node_id: reference.node_id })
  };
}

export function parseRuntimeReference<TReference extends RuntimeReference>(
  value: JsonValue,
  invalid: () => Error
): TReference {
  if (
    !isCheckpointPlainObject(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.uri !== "string" ||
    value.uri.length === 0 ||
    (value.node_id !== undefined &&
      (typeof value.node_id !== "string" || value.node_id.length === 0)) ||
    Object.keys(value).some((key) => !["id", "uri", "node_id"].includes(key))
  ) {
    throw invalid();
  }

  return {
    id: value.id,
    uri: value.uri,
    ...(value.node_id === undefined ? {} : { node_id: value.node_id })
  } as TReference;
}

export function mergeRuntimeReferences<TReference extends RuntimeReference>(
  ...collections: readonly (readonly TReference[])[]
): TReference[] {
  const merged = new Map<string, TReference>();
  for (const reference of collections.flat()) {
    merged.set(runtimeReferenceKey(reference), reference);
  }
  return [...merged.values()];
}

export function runtimeReferenceCollectionsEqual(
  left: readonly RuntimeReference[],
  right: readonly RuntimeReference[]
): boolean {
  return stableJson(left.map(encodeRuntimeReference)) ===
    stableJson(right.map(encodeRuntimeReference));
}
