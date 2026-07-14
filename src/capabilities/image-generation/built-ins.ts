import { createHash } from "node:crypto";
import { z } from "zod";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import { nodeOutputWithBinaryAssets } from "../../core/runtime/artifacts/binary-asset.js";
import type {
  BuiltInStep,
  BuiltInStepDependencies,
  BuiltInStepRunOptions
} from "../../core/built-ins/types.js";
import {
  DEFAULT_IMAGE_GENERATION_TIMEOUT_MS,
  GeneratedImagePayloadSchema,
  ImageGenerationInputSchema,
  MAX_IMAGE_GENERATION_TIMEOUT_MS,
  MAX_GENERATED_IMAGE_BYTES,
  type ImageGenerationBuiltInPorts
} from "./contracts.js";
import { validateGeneratedPngBase64 } from "./png-payload.js";

export type ImageGenerationBuiltInPortResolver =
  | ImageGenerationBuiltInPorts
  | ((options: BuiltInStepRunOptions) => ImageGenerationBuiltInPorts);

type ImageGenerationBuiltInDependencies = BuiltInStepDependencies & {
  readonly imageGeneration?: ImageGenerationBuiltInPorts;
};

function imageGenerationError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function imageGenerationPortsFromBuiltInOptions({
  dependencies = {}
}: BuiltInStepRunOptions<ImageGenerationBuiltInDependencies>): ImageGenerationBuiltInPorts {
  if (dependencies.imageGeneration === undefined) {
    throw imageGenerationError(
      "Image generation ports are not configured for this runtime.",
      "image_generation_port_unavailable"
    );
  }
  return dependencies.imageGeneration;
}

export function createImageGenerateBuiltIn(
  ports: ImageGenerationBuiltInPortResolver
): BuiltInStep<"image-generation.generate"> {
  return defineBuiltInStep({
    name: "image-generation.generate",
    async run(options) {
      const resolvedPorts = typeof ports === "function" ? ports(options) : ports;
      const parsed = ImageGenerationInputSchema.omit({ project_root: true }).extend({
        timeout_ms: z.number().int().min(1).max(MAX_IMAGE_GENERATION_TIMEOUT_MS).optional()
      }).safeParse({
        operation_id: options.input?.operation_id ?? "image-generation.generate",
        provider_id: options.input?.provider_id,
        prompt: options.input?.prompt,
        size: options.input?.size,
        quality: options.input?.quality,
        timeout_ms: options.input?.timeout_ms
      });
      if (!parsed.success) {
        throw imageGenerationError(
          "Image generation input did not match the generate schema.",
          "image_generation_input_invalid"
        );
      }

      const { timeout_ms: timeoutMs, ...providerInput } = parsed.data;
      const input = ImageGenerationInputSchema.parse({
        ...providerInput,
        project_root: resolvedPorts.projectRoot
      });
      const generatedResult = await resolvedPorts.providers
        .get(input.provider_id)
        .generateImage(input, {
          timeoutMs: timeoutMs ?? DEFAULT_IMAGE_GENERATION_TIMEOUT_MS,
          maxImageBytes: MAX_GENERATED_IMAGE_BYTES,
          ...(options.signal === undefined ? {} : { signal: options.signal })
        });
      const generated = GeneratedImagePayloadSchema.safeParse(generatedResult);
      if (!generated.success) {
        throw imageGenerationError(
          "Image generation provider returned output outside the public pi-imagegen contract.",
          "image_generation_invalid_output"
        );
      }
      const nodeId = options.node?.id;
      if (nodeId === undefined) {
        throw imageGenerationError(
          "Image generation requires workflow node context.",
          "image_generation_context_invalid"
        );
      }
      const validatedPayload = validateGeneratedPngBase64(
        generated.data.image_base64,
        MAX_GENERATED_IMAGE_BYTES
      );
      if (!validatedPayload.valid) {
        throw imageGenerationError(
          validatedPayload.reason === "oversized"
            ? "Image generation provider returned an oversized PNG payload."
            : "Image generation provider returned invalid PNG content.",
          validatedPayload.reason === "oversized"
            ? "image_generation_payload_too_large"
            : "image_generation_invalid_output"
        );
      }
      const bytes = validatedPayload.bytes;
      const digest = createHash("sha256").update(bytes).digest("hex");
      const artifact = await resolvedPorts.artifacts.publish({
        node_id: nodeId,
        path: `generated-images/${digest}.png`,
        format: "png",
        value: generated.data.image_base64,
        semantic_type: "luna.generated-image.v1",
        overwrite_policy: "forbid"
      });
      const { image_base64: _discardedImageBytes, ...metadata } = generated.data;
      const output = {
        ...metadata,
        asset: {
          ...artifact,
          media_type: "image/png" as const,
          content_hash: `sha256:${digest}`,
          size_bytes: bytes.byteLength
        }
      };
      return nodeOutputWithBinaryAssets(output, {
        produced: [output.asset],
        forwarded: []
      });
    }
  });
}
