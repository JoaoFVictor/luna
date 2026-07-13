const OBJECT_HEADER_BYTES = 64;
const CONTAINER_ENTRY_BYTES = 24;
const REFERENCE_BYTES = 8;

// This is deliberately a conservative retention model, not a claim about one
// V8 release's exact object layout. Shared object references are counted once;
// strings and container slots include UTF-16 storage and structural overhead.
export function estimateRetainedBytes(value: unknown): number {
  const seen = new WeakSet<object>();

  function estimate(current: unknown): number {
    if (current === null || current === undefined) {
      return 0;
    }
    if (typeof current === "string") {
      return OBJECT_HEADER_BYTES + current.length * 2;
    }
    if (typeof current === "number" || typeof current === "boolean" ||
      typeof current === "bigint") {
      return 8;
    }
    if (typeof current === "symbol" || typeof current === "function") {
      return OBJECT_HEADER_BYTES;
    }
    if (typeof current !== "object") {
      return 0;
    }
    if (seen.has(current)) {
      return REFERENCE_BYTES;
    }
    seen.add(current);

    if (Buffer.isBuffer(current)) {
      return OBJECT_HEADER_BYTES + current.byteLength;
    }
    if (Array.isArray(current)) {
      return OBJECT_HEADER_BYTES + current.length * REFERENCE_BYTES +
        current.reduce((total, entry) => total + estimate(entry), 0);
    }
    if (current instanceof Map) {
      let bytes = OBJECT_HEADER_BYTES + current.size * CONTAINER_ENTRY_BYTES;
      for (const [key, entry] of current) {
        bytes += estimate(key) + estimate(entry);
      }
      return bytes;
    }
    if (current instanceof Set) {
      let bytes = OBJECT_HEADER_BYTES + current.size * CONTAINER_ENTRY_BYTES;
      for (const entry of current) {
        bytes += estimate(entry);
      }
      return bytes;
    }

    let bytes = OBJECT_HEADER_BYTES;
    for (const [key, entry] of Object.entries(current)) {
      bytes += CONTAINER_ENTRY_BYTES + key.length * 2 + estimate(entry);
    }
    return bytes;
  }

  return estimate(value);
}
