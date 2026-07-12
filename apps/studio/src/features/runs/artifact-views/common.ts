import { z } from "zod"

import type { JsonValue } from "@/api/types"

export const MAX_ARTIFACT_VIEW_ITEMS = 500
export const MAX_ARTIFACT_VIEW_TEXT = 20_000
export const MAX_ARTIFACT_RAW_PREVIEW_TEXT = 256 * 1024

function artifactViewTextSchema(minimum: number) {
  return z
    .string()
    .min(minimum)
    .max(MAX_ARTIFACT_VIEW_TEXT)
    .refine((value) => !value.includes("\0"), "Text contains a NUL character")
}

export const ArtifactViewTextSchema = artifactViewTextSchema(0)
export const ArtifactViewNonEmptyTextSchema = artifactViewTextSchema(1)
export const ArtifactRawPreviewTextSchema = z
  .string()
  .max(MAX_ARTIFACT_RAW_PREVIEW_TEXT)
  .refine((value) => !value.includes("\0"), "Text contains a NUL character")

export const RepositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    if (
      value.startsWith("/") ||
      value.startsWith("\\") ||
      /^[A-Za-z]:/.test(value) ||
      value === "~" ||
      value.startsWith("~/") ||
      value.includes("\\") ||
      value.includes("\0")
    ) {
      return false
    }
    return value
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  }, "Path must be repository-relative")

const FILE_URI_PATTERN = /\bfile:\/\/[^\s<>"')\]},;]+/gi
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\s<>:"|?*)\]}',;]+/g
const UNC_PATH_PATTERN = /\\\\[A-Za-z0-9._-]+\\[^\s<>:"|?*)\]}',;]+/g
const POSIX_PATH_PATTERN =
  /(^|[\s([{"'=])\/(?!\/)[^\s/<>:"|?*)\]}',;]+(?:\/[^\s/<>:"|?*)\]}',;]+)*/g

/** Defense in depth for model-authored prose. Structured physical path fields
 * are omitted by their projections; this covers paths embedded in free text. */
export function redactPhysicalPaths(value: string): string {
  return value
    .replace(FILE_URI_PATTERN, "[PATH REDACTED]")
    .replace(UNC_PATH_PATTERN, "[PATH REDACTED]")
    .replace(WINDOWS_PATH_PATTERN, "[PATH REDACTED]")
    .replace(POSIX_PATH_PATTERN, (_match, prefix: string) => `${prefix}[PATH REDACTED]`)
}

/** Keeps the generic structured fallback useful without re-exposing physical
 * paths hidden by specialized projections. Artifact preview JSON is already
 * complexity-bounded by the server contract. */
export function redactPhysicalPathsInJson(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactPhysicalPaths(value)
  if (Array.isArray(value)) return value.map(redactPhysicalPathsInJson)
  if (value === null || typeof value !== "object") return value

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      redactPhysicalPaths(key),
      redactPhysicalPathsInJson(nested),
    ]),
  )
}

export function abbreviatedRevision(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12)
}
