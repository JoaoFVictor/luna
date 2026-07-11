import { z } from "zod";
import { ArtifactSemanticTypeSchema } from "../../core/artifacts/semantic-type.js";
import { RunOpaqueIdSchema } from "./runs.js";
import { StudioJsonValueSchema } from "./json.js";

const TimestampSchema = z.string().datetime({ offset: true });
const SafeBytesSchema = z.number().int().safe().nonnegative();
const SafeMediaTypeSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21-\x7e]+$/, "Media type contains unsupported characters");

export const ArtifactManifestHandleSchema = z
  .string()
  .regex(/^ah_[A-Za-z0-9_-]{43}$/, "Invalid artifact handle");
export type ArtifactManifestHandle = z.infer<typeof ArtifactManifestHandleSchema>;

export const ArtifactExposureStatusSchema = z.enum([
  "committed",
  "pending",
  "failed",
  "legacy"
]);
export type ArtifactExposureStatus = z.infer<typeof ArtifactExposureStatusSchema>;

export const ArtifactSummarySchema = z
  .object({
    manifest_handle: ArtifactManifestHandleSchema,
    name: z.string().min(1).max(256),
    source_node_id: z.string().min(1).max(256).optional(),
    attempt: z.number().int().safe().positive(),
    media_type: SafeMediaTypeSchema,
    semantic_type: ArtifactSemanticTypeSchema.optional(),
    content_hash: z.string().min(1).max(256).optional(),
    status: ArtifactExposureStatusSchema,
    created_at: TimestampSchema,
    preview_capability: z.enum([
      "probe_required",
      "download_only",
      "unavailable"
    ])
  })
  .strict();
export type ArtifactSummary = z.infer<typeof ArtifactSummarySchema>;

export const ArtifactListSchema = z
  .object({
    run_id: RunOpaqueIdSchema,
    items: z.array(ArtifactSummarySchema).max(10_000),
    redaction: z.literal("best_effort_on_preview")
  })
  .strict();
export type ArtifactList = z.infer<typeof ArtifactListSchema>;

export const ArtifactMetadataSchema = ArtifactSummarySchema.extend({
  content_length: SafeBytesSchema,
  downloadable: z.boolean(),
  raw_download_redaction: z.literal("not_applied")
}).strict();
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

const ArtifactPreviewBaseSchema = z
  .object({
    metadata: ArtifactMetadataSchema,
    inspected_bytes: SafeBytesSchema,
    truncated: z.boolean(),
    integrity: z.enum(["verified", "not_checked", "not_declared"])
  })
  .strict();

const PreviewRedactionSchema = z
  .object({
    mode: z.literal("best_effort"),
    changed: z.boolean()
  })
  .strict();

export const ArtifactTextPreviewSchema = ArtifactPreviewBaseSchema.extend({
  kind: z.literal("text"),
  encoding: z.literal("utf-8"),
  text: z.string(),
  redaction: PreviewRedactionSchema,
  diagnostic: z.enum(["invalid_json", "json_complexity_limit"]).optional(),
  render_policy: z.literal("plain_text_only")
}).strict();

export const ArtifactJsonPreviewSchema = ArtifactPreviewBaseSchema.extend({
  kind: z.literal("json"),
  encoding: z.literal("utf-8"),
  value: StudioJsonValueSchema,
  redaction: PreviewRedactionSchema,
  render_policy: z.literal("structured_data_only")
}).strict();

export const ArtifactBinaryPreviewSchema = ArtifactPreviewBaseSchema.extend({
  kind: z.literal("binary"),
  reason: z.literal("binary_content"),
  render_policy: z.literal("download_only")
}).strict();

export const ArtifactActiveContentPreviewSchema = ArtifactPreviewBaseSchema.extend({
  kind: z.literal("download_only"),
  reason: z.literal("active_content"),
  render_policy: z.literal("download_only")
}).strict();

export const ArtifactPreviewSchema = z.discriminatedUnion("kind", [
  ArtifactTextPreviewSchema,
  ArtifactJsonPreviewSchema,
  ArtifactBinaryPreviewSchema,
  ArtifactActiveContentPreviewSchema
]);
export type ArtifactPreview = z.infer<typeof ArtifactPreviewSchema>;

export const ArtifactPreviewRequestSchema = z
  .object({
    run_id: RunOpaqueIdSchema,
    manifest_handle: ArtifactManifestHandleSchema,
    max_bytes: z.number().int().safe().min(1).optional()
  })
  .strict();
export type ArtifactPreviewRequest = z.input<typeof ArtifactPreviewRequestSchema>;
