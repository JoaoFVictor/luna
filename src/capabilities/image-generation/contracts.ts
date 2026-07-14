import { z } from "zod";
import { BinaryAssetRefSchema } from "../../core/runtime/artifacts/binary-asset.js";
import type { ArtifactPublisherPort } from "../artifacts/publisher.js";
import {
  MAX_GENERATED_IMAGE_BASE64_CHARACTERS,
  MAX_GENERATED_IMAGE_BYTES
} from "./png-payload.js";

export const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 180_000;

const NonEmptyStringSchema = z.string().min(1);

export const ImageGenerationInputSchema = z.object({
  operation_id: z.literal("image-generation.generate"),
  provider_id: z.literal("pi-imagegen"),
  prompt: NonEmptyStringSchema.max(4000),
  size: z.enum(["1024x1024", "1024x1536", "1536x1024", "auto"]),
  quality: z.enum(["low", "medium", "high", "auto"]),
  project_root: NonEmptyStringSchema
}).strict();

export const GeneratedImagePayloadSchema = z.object({
  operation_id: z.literal("image-generation.generate"),
  provider: z.literal("pi-imagegen"),
  provider_id: z.literal("pi-imagegen"),
  model: NonEmptyStringSchema,
  prompt: NonEmptyStringSchema,
  revised_prompt: z.string().optional(),
  size: ImageGenerationInputSchema.shape.size,
  quality: ImageGenerationInputSchema.shape.quality,
  media_type: z.literal("image/png"),
  image_base64: NonEmptyStringSchema.max(MAX_GENERATED_IMAGE_BASE64_CHARACTERS),
  metadata: z.object({
    provider: z.literal("pi-imagegen"),
    model: NonEmptyStringSchema,
    prompt: NonEmptyStringSchema,
    revised_prompt: z.string().optional(),
    size: ImageGenerationInputSchema.shape.size,
    quality: ImageGenerationInputSchema.shape.quality,
    media_type: z.literal("image/png")
  }).strict()
}).strict();

export const GeneratedImageResultSchema = GeneratedImagePayloadSchema
  .omit({ image_base64: true })
  .extend({ asset: BinaryAssetRefSchema })
  .strict();

export type ImageGenerationInput = z.infer<typeof ImageGenerationInputSchema>;

export type GeneratedImageResult = z.infer<typeof GeneratedImageResultSchema>;

export type GeneratedImagePayload = z.infer<typeof GeneratedImagePayloadSchema>;

export type ImageGenerationExecutionOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxImageBytes: number;
};

export type ImageGenerationProviderPort = {
  readonly provider_id: "pi-imagegen";
  generateImage(
    input: ImageGenerationInput,
    options: ImageGenerationExecutionOptions
  ): GeneratedImagePayload | Promise<GeneratedImagePayload>;
};

export type ImageGenerationProviderFactory = {
  readonly provider_id: "pi-imagegen";
  createProvider(): ImageGenerationProviderPort;
};

export type ImageGenerationProviderRegistry = {
  get(providerId: string): ImageGenerationProviderPort;
};

export type ImageGenerationBuiltInPorts = {
  readonly providers: ImageGenerationProviderRegistry;
  readonly projectRoot: string;
  readonly artifacts: ArtifactPublisherPort;
};

export { MAX_GENERATED_IMAGE_BYTES };
