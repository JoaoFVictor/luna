const RESERVED_RUN_PATH_SEGMENTS = new Set([
  ".manifests",
  ".pending",
  "events.jsonl",
  "runtime.log.jsonl",
  "trace.jsonl"
]);

function canonicalFilesystemName(value: string): string {
  return value.toLowerCase();
}

/**
 * Filesystem artifact payloads share a run directory with runtime-owned data.
 * Reserved names therefore use ASCII case-insensitive comparison even on a
 * case-sensitive host, so a bundle cannot become unsafe when moved to another
 * supported filesystem.
 */
export function isReservedFilesystemArtifactPath(artifactPath: string): boolean {
  const first = canonicalFilesystemName(artifactPath.split("/", 1)[0] ?? "");
  return RESERVED_RUN_PATH_SEGMENTS.has(first);
}
