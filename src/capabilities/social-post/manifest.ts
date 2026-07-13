import { capabilityManifest } from "../../core/capabilities/manifest.js";

const expressionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expression"],
  properties: {
    expression: { type: "string" }
  }
} as const;

const stringOrExpressionSchema = {
  anyOf: [{ type: "string" }, expressionSchema]
} as const;

const publishInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider_id", "auth_instance", "text", "image_asset"],
  properties: {
    operation_id: { enum: ["social-post.publish"] },
    provider_id: stringOrExpressionSchema,
    auth_instance: stringOrExpressionSchema,
    text: stringOrExpressionSchema,
    image_asset: {
      anyOf: [
        { type: "object", additionalProperties: true },
        expressionSchema
      ]
    }
  }
} as const;

const publishOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "operation_id",
    "provider",
    "provider_id",
    "external_id",
    "url",
    "text",
    "media_id"
  ],
  properties: {
    operation_id: { enum: ["social-post.publish"] },
    provider: { type: "string" },
    provider_id: { type: "string" },
    external_id: { type: "string" },
    url: { type: "string" },
    text: { type: "string" },
    media_id: { type: "string" }
  }
} as const;

const publishPolicySchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id"],
  properties: {
    operation_id: { enum: ["social-post.publish"] }
  }
} as const;

export const manifest = capabilityManifest({
  id: "social-post",
  kind: "execution",
  version: "2026.07.12",
  ports: {
    "social-post.provider": {
      id: "social-post.provider",
      capability: "social-post",
      option_schema: {
        type: "object",
        additionalProperties: false,
        required: ["provider_id"],
        properties: {
          provider_id: { type: "string" }
        }
      },
      lifecycle: ["validate"],
      error_codes: [
        "social_post_auth_failed",
        "social_post_provider_unavailable",
        "social_post_publish_failed"
      ]
    }
  },
  built_ins: {
    "social-post.publish": {
      id: "social-post.publish",
      input_schema: publishInputSchema,
      output_schema: publishOutputSchema,
      required_ports: ["social-post.provider"],
      side_effect_policy: "social-post.publish_side_effect"
    }
  },
  policies: {
    "social-post.publish_side_effect": {
      id: "social-post.publish_side_effect",
      config_schema: publishPolicySchema,
      side_effect_semantics: "write",
      side_effect_category: "external_write",
      side_effect_operation_ids: ["social-post.publish"],
      idempotency_scope: "attempt",
      retry_semantics: "retry_forbidden",
      error_codes: ["social_post_unknown_publish_outcome"]
    }
  },
  docs: [{ title: "Provider-neutral social post publishing" }]
});
