import { capabilityManifest } from "../../core/capabilities/manifest.js";

const expressionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expression"],
  properties: { expression: { type: "string" } }
} as const;
const stringOrExpressionSchema = {
  anyOf: [{ type: "string" }, expressionSchema]
} as const;
const timeoutOrExpressionSchema = {
  anyOf: [
    { type: "integer", minimum: 1, maximum: 900_000 },
    expressionSchema
  ]
} as const;
export const manifest = capabilityManifest({
  id: "image-generation",
  kind: "execution",
  version: "2026.07.14",
  ports: {
    "image-generation.provider": {
      id: "image-generation.provider",
      capability: "image-generation",
      option_schema: {
        type: "object",
        additionalProperties: false,
        required: ["provider_id"],
        properties: { provider_id: { type: "string" } }
      },
      lifecycle: ["validate"],
      error_codes: [
        "image_generation_auth_failed",
        "image_generation_extension_unavailable",
        "image_generation_provider_unavailable",
        "image_generation_invalid_output",
        "image_generation_failed"
      ]
    }
  },
  built_ins: {
    "image-generation.generate": {
      id: "image-generation.generate",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["provider_id", "prompt", "size", "quality"],
        properties: {
          operation_id: { enum: ["image-generation.generate"] },
          provider_id: {
            anyOf: [{ enum: ["pi-imagegen"] }, expressionSchema]
          },
          prompt: stringOrExpressionSchema,
          size: stringOrExpressionSchema,
          quality: stringOrExpressionSchema,
          timeout_ms: timeoutOrExpressionSchema
        }
      },
      output_schema: {
        type: "object",
        additionalProperties: false,
        required: [
          "operation_id", "provider", "provider_id", "model", "prompt",
          "size", "quality", "media_type", "asset", "metadata"
        ],
        properties: {
          operation_id: { enum: ["image-generation.generate"] },
          provider: { enum: ["pi-imagegen"] },
          provider_id: { enum: ["pi-imagegen"] },
          model: { type: "string" },
          prompt: { type: "string" },
          revised_prompt: { type: "string" },
          size: { type: "string" },
          quality: { type: "string" },
          media_type: { enum: ["image/png"] },
          asset: {
            type: "object",
            additionalProperties: false,
            required: ["id", "uri", "node_id", "media_type", "content_hash", "size_bytes"],
            properties: {
              id: { type: "string" },
              uri: { type: "string" },
              node_id: { type: "string" },
              media_type: { enum: ["image/png"] },
              content_hash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
              size_bytes: { type: "integer", minimum: 1 }
            }
          },
          metadata: {
            type: "object",
            additionalProperties: false,
            required: ["provider", "model", "prompt", "size", "quality", "media_type"],
            properties: {
              provider: { enum: ["pi-imagegen"] },
              model: { type: "string" },
              prompt: { type: "string" },
              revised_prompt: { type: "string" },
              size: { type: "string" },
              quality: { type: "string" },
              media_type: { enum: ["image/png"] }
            }
          }
        }
      },
      required_ports: ["image-generation.provider"],
      side_effect_policy: "image-generation.generate_side_effect"
    }
  },
  policies: {
    "image-generation.generate_side_effect": {
      id: "image-generation.generate_side_effect",
      config_schema: {
        type: "object",
        additionalProperties: false,
        required: ["operation_id"],
        properties: { operation_id: { enum: ["image-generation.generate"] } }
      },
      side_effect_semantics: "read",
      side_effect_category: "model_call",
      side_effect_operation_ids: ["image-generation.generate"],
      idempotency_scope: "attempt",
      retry_semantics: "retry_forbidden",
      error_codes: ["image_generation_unknown_outcome"]
    }
  },
  docs: [{ title: "Image generation through the Pi imagegen extension" }]
});
