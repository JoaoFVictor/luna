import path from "node:path";
import type { JsonValue } from "../../../core/json/value.js";
import type { ArtifactManifest } from "../../../core/runtime/artifacts/contracts.js";
import type { ArtifactExposureStatus } from "../../contracts/artifacts.js";

function baseMediaType(mediaType: string): string {
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function normalizedArtifactMediaType(
  manifest: ArtifactManifest,
  artifactPath: string
): string {
  const declared = manifest.media_type?.trim().toLowerCase();
  if (
    declared !== undefined &&
    declared.length > 0 &&
    declared.length <= 256 &&
    /^[\x21-\x7e]+$/.test(declared)
  ) {
    return declared.split(";", 1)[0] ?? "application/octet-stream";
  }

  switch (path.extname(artifactPath).toLowerCase()) {
    case ".json":
      return "application/json";
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".html":
    case ".htm":
      return "text/html";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

export function safeArtifactDisplayName(artifactPath: string): string {
  const base = path.posix.basename(artifactPath)
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/^\.+$/, "artifact")
    .slice(0, 256);
  return base === "" ? "artifact" : base;
}

export function artifactExposureStatus(
  manifest: ArtifactManifest
): ArtifactExposureStatus {
  return manifest.status ?? "legacy";
}

export function isReadableArtifactStatus(
  status: ArtifactExposureStatus
): boolean {
  return status === "committed" || status === "legacy";
}

export function isActiveArtifactContent(mediaType: string): boolean {
  return new Set([
    "application/javascript",
    "application/xhtml+xml",
    "image/svg+xml",
    "text/html",
    "text/javascript"
  ]).has(baseMediaType(mediaType));
}

export function isJsonArtifactMediaType(mediaType: string): boolean {
  const media = baseMediaType(mediaType);
  return media === "application/json" || media.endsWith("+json");
}

export function isPlausiblyBinaryArtifact(content: Uint8Array): boolean {
  if (content.length === 0) {
    return false;
  }
  let suspicious = 0;
  for (const byte of content) {
    if (byte === 0) {
      return true;
    }
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      suspicious += 1;
    }
  }
  return suspicious / content.length > 0.1;
}

export function validatedArtifactJsonValue(
  value: unknown,
  maxDepth: number,
  maxNodes: number
): { kind: "valid"; value: JsonValue } | { kind: "too_complex" } {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 0 }
  ];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    nodes += 1;
    if (nodes > maxNodes || current.depth > maxDepth) {
      return { kind: "too_complex" };
    }
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "number" && Number.isFinite(current.value)) {
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const nested of current.value) {
        stack.push({ value: nested, depth: current.depth + 1 });
      }
      continue;
    }
    if (typeof current.value === "object") {
      for (const nested of Object.values(current.value)) {
        stack.push({ value: nested, depth: current.depth + 1 });
      }
      continue;
    }
    return { kind: "too_complex" };
  }

  return { kind: "valid", value: value as JsonValue };
}
