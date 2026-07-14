import { z } from "zod";
import { BinaryAssetRefSchema, type BinaryAssetRef } from "../../core/runtime/artifacts/binary-asset.js";
import type { ArtifactPublisherPort } from "../artifacts/publisher.js";

const NonEmptyStringSchema = z.string().min(1);
export const SOCIAL_POST_HARD_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const SOCIAL_POST_HARD_MAX_TEXT_CODE_POINTS = 10_000;
export const SOCIAL_POST_HARD_MAX_STRATEGY_LENGTH = 4_000;
export const SOCIAL_POST_HARD_MAX_CLAIMS = 64;
export const SOCIAL_POST_HARD_MAX_CLAIM_LENGTH = 2_048;
export const SOCIAL_POST_HARD_MAX_IMAGE_DIMENSION = 16_384;
export const SOCIAL_POST_HARD_MAX_IMAGE_PIXELS = 64 * 1024 * 1024;

export const SocialPostDraftSchema = z.object({
  text: NonEmptyStringSchema.refine(
    (value) => [...value].length <= SOCIAL_POST_HARD_MAX_TEXT_CODE_POINTS
  ),
  image_prompt: NonEmptyStringSchema.max(4000),
  strategy: NonEmptyStringSchema.max(SOCIAL_POST_HARD_MAX_STRATEGY_LENGTH),
  character_count: z.number().int().min(1).max(SOCIAL_POST_HARD_MAX_TEXT_CODE_POINTS),
  claims_to_verify: z.array(
    NonEmptyStringSchema.max(SOCIAL_POST_HARD_MAX_CLAIM_LENGTH)
  ).max(SOCIAL_POST_HARD_MAX_CLAIMS)
}).strict();

export const SocialPostRevisionTargetSchema = z.enum(["text", "image"]);

export const SocialPostApplyRevisionScopeInputSchema = z.object({
  proposed_draft: SocialPostDraftSchema,
  previous_draft: SocialPostDraftSchema.nullable().optional(),
  targets: z.array(SocialPostRevisionTargetSchema).min(1).max(2)
}).strict();

export const SocialPostProviderLimitsSchema = z.object({
  text: z.object({
    policy_id: NonEmptyStringSchema.max(256),
    policy_revision: NonEmptyStringSchema.max(256),
    max_weighted_length: z.number().int().safe().positive()
      .max(SOCIAL_POST_HARD_MAX_TEXT_CODE_POINTS)
  }).strict(),
  image: z.object({
    max_bytes: z.number().int().safe().min(8).max(SOCIAL_POST_HARD_MAX_IMAGE_BYTES),
    media_types: z.array(z.literal("image/png")).min(1),
    max_width: z.number().int().safe().positive().max(SOCIAL_POST_HARD_MAX_IMAGE_DIMENSION),
    max_height: z.number().int().safe().positive().max(SOCIAL_POST_HARD_MAX_IMAGE_DIMENSION),
    max_pixels: z.number().int().safe().positive().max(SOCIAL_POST_HARD_MAX_IMAGE_PIXELS)
  }).strict()
}).strict();

export const SocialPostTextPolicyResultSchema = z.object({
  valid: z.boolean(),
  weighted_length: z.number().int().safe().nonnegative(),
  max_weighted_length: z.number().int().safe().positive(),
  policy_id: NonEmptyStringSchema.max(256),
  policy_revision: NonEmptyStringSchema.max(256),
  message: NonEmptyStringSchema.max(2048)
}).strict();

const SocialPostContentSchema = z.object({
  provider_id: NonEmptyStringSchema,
  text: NonEmptyStringSchema.refine(
    (value) => [...value].length <= SOCIAL_POST_HARD_MAX_TEXT_CODE_POINTS
  ),
  image_asset: BinaryAssetRefSchema.extend({
    media_type: z.literal("image/png")
  }).strict()
}).strict();

export const SocialPostPrepareInputSchema = SocialPostContentSchema;

const SocialPostValidationBaseSchema = z.object({
  text_weighted_length: z.number().int().safe().nonnegative(),
  text_max_weighted_length: z.number().int().safe().positive(),
  text_policy_id: NonEmptyStringSchema.max(256),
  text_policy_revision: NonEmptyStringSchema.max(256),
  image_size_bytes: z.number().int().safe().positive(),
  image_max_bytes: z.number().int().safe().positive()
    .max(SOCIAL_POST_HARD_MAX_IMAGE_BYTES),
  image_media_type: z.literal("image/png"),
  image_width: z.number().int().safe().nonnegative(),
  image_height: z.number().int().safe().nonnegative(),
  message: NonEmptyStringSchema.max(2048)
}).strict();

export const SocialPostPreparationValidationSchema = z.discriminatedUnion("valid", [
  SocialPostValidationBaseSchema.extend({
    valid: z.literal(true),
    code: z.literal("ready")
  }).strict(),
  SocialPostValidationBaseSchema.extend({
    valid: z.literal(false),
    code: z.enum(["text_invalid", "image_too_large", "image_invalid"])
  }).strict()
]);

export const SocialPostPreparedResultSchema = z.object({
  provider_id: NonEmptyStringSchema,
  text_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  image_content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  validation: SocialPostPreparationValidationSchema
}).strict();

export const SocialPostPublishInputSchema = z
  .object({
    operation_id: z.literal("social-post.publish"),
    provider_id: NonEmptyStringSchema,
    auth_instance: NonEmptyStringSchema,
    text: NonEmptyStringSchema.refine(
      (value) => [...value].length <= SOCIAL_POST_HARD_MAX_TEXT_CODE_POINTS
    ),
    image_base64: NonEmptyStringSchema,
    image_media_type: z.literal("image/png"),
    project_root: NonEmptyStringSchema
  })
  .strict();

export const SocialPostWorkflowInputSchema = SocialPostContentSchema.extend({
  operation_id: z.literal("social-post.publish"),
  auth_instance: NonEmptyStringSchema,
  preparation: SocialPostPreparedResultSchema
}).strict();

export type SocialPostPublishInput = z.infer<typeof SocialPostPublishInputSchema>;

export type SocialPostWorkflowInput = z.infer<typeof SocialPostWorkflowInputSchema>;

export type SocialPostPrepareInput = z.infer<typeof SocialPostPrepareInputSchema>;

export type SocialPostDraft = z.infer<typeof SocialPostDraftSchema>;

export type SocialPostPreparedResult = z.infer<typeof SocialPostPreparedResultSchema>;

export type SocialPostProviderLimits = z.infer<typeof SocialPostProviderLimitsSchema>;

export type SocialPostTextPolicyResult = z.infer<typeof SocialPostTextPolicyResultSchema>;

export type SocialPostPublishedResult = {
  readonly operation_id: "social-post.publish";
  readonly provider: string;
  readonly provider_id: string;
  readonly external_id: string;
  readonly url: string;
  readonly text: string;
  readonly media_id: string;
};

export type SocialPostProviderPort = {
  readonly provider_id: string;
  readonly limits: SocialPostProviderLimits;
  validateText(text: string): SocialPostTextPolicyResult;
  publishPost(
    input: SocialPostPublishInput
  ): SocialPostPublishedResult | Promise<SocialPostPublishedResult>;
};

export type SocialPostProviderFactory = {
  readonly provider_id: string;
  createProvider(): SocialPostProviderPort;
};

export type SocialPostProviderRegistry = {
  get(providerId: string): SocialPostProviderPort;
};

export type SocialPostBuiltInPorts = {
  readonly providers: SocialPostProviderRegistry;
  readonly projectRoot: string;
  readonly artifacts: Pick<ArtifactPublisherPort, "read" | "verify">;
};

export type SocialPostImageAsset = BinaryAssetRef;
