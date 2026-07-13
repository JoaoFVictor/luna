import { z } from "zod";
import { BinaryAssetRefSchema, type BinaryAssetRef } from "../../core/runtime/artifacts/binary-asset.js";
import type { ArtifactPublisherPort } from "../artifacts/publisher.js";

const NonEmptyStringSchema = z.string().min(1);

export const SocialPostPublishInputSchema = z
  .object({
    operation_id: z.literal("social-post.publish"),
    provider_id: NonEmptyStringSchema,
    auth_instance: NonEmptyStringSchema,
    text: NonEmptyStringSchema.max(280),
    image_base64: NonEmptyStringSchema,
    image_media_type: z.literal("image/png"),
    project_root: NonEmptyStringSchema
  })
  .strict();

export const SocialPostWorkflowInputSchema = z.object({
  operation_id: z.literal("social-post.publish"),
  provider_id: NonEmptyStringSchema,
  auth_instance: NonEmptyStringSchema,
  text: NonEmptyStringSchema.max(280),
  image_asset: BinaryAssetRefSchema.extend({
    media_type: z.literal("image/png")
  }).strict()
}).strict();

export type SocialPostPublishInput = z.infer<typeof SocialPostPublishInputSchema>;

export type SocialPostWorkflowInput = z.infer<typeof SocialPostWorkflowInputSchema>;

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
  readonly artifacts: Pick<ArtifactPublisherPort, "read">;
};

export type SocialPostImageAsset = BinaryAssetRef;
