import { capabilityManifest } from "../../core/capabilities/manifest.js";
import {
  SOCIAL_POST_HARD_MAX_CLAIM_LENGTH,
  SOCIAL_POST_HARD_MAX_CLAIMS,
  SOCIAL_POST_HARD_MAX_STRATEGY_LENGTH
} from "./contracts.js";

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

const draftSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "text",
    "image_prompt",
    "strategy",
    "character_count",
    "claims_to_verify"
  ],
  properties: {
    text: { type: "string", minLength: 1, maxLength: 10000 },
    image_prompt: { type: "string", minLength: 1, maxLength: 4000 },
    strategy: {
      type: "string",
      minLength: 1,
      maxLength: SOCIAL_POST_HARD_MAX_STRATEGY_LENGTH
    },
    character_count: { type: "integer", minimum: 1, maximum: 10000 },
    claims_to_verify: {
      type: "array",
      maxItems: SOCIAL_POST_HARD_MAX_CLAIMS,
      items: {
        type: "string",
        minLength: 1,
        maxLength: SOCIAL_POST_HARD_MAX_CLAIM_LENGTH
      }
    }
  }
} as const;

const applyRevisionScopeInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["proposed_draft", "previous_draft", "targets"],
  properties: {
    proposed_draft: expressionSchema,
    previous_draft: expressionSchema,
    targets: expressionSchema
  }
} as const;

const publishInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider_id", "auth_instance", "text", "image_asset", "preparation"],
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
    },
    preparation: {
      anyOf: [
        { type: "object", additionalProperties: true },
        expressionSchema
      ]
    }
  }
} as const;

const prepareInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider_id", "text", "image_asset"],
  properties: {
    provider_id: stringOrExpressionSchema,
    text: stringOrExpressionSchema,
    image_asset: {
      anyOf: [
        { type: "object", additionalProperties: true },
        expressionSchema
      ]
    }
  }
} as const;

const prepareOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider_id", "text_hash", "image_content_hash", "validation"],
  properties: {
    provider_id: { type: "string" },
    text_hash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    image_content_hash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    validation: {
      type: "object",
      additionalProperties: false,
      required: [
        "valid",
        "code",
        "message",
        "text_weighted_length",
        "text_max_weighted_length",
        "text_policy_id",
        "text_policy_revision",
        "image_size_bytes",
        "image_max_bytes",
        "image_media_type",
        "image_width",
        "image_height"
      ],
      properties: {
        valid: { type: "boolean" },
        code: { enum: ["ready", "text_invalid", "image_too_large", "image_invalid"] },
        message: { type: "string", minLength: 1, maxLength: 2048 },
        text_weighted_length: { type: "integer", minimum: 0 },
        text_max_weighted_length: { type: "integer", minimum: 1, maximum: 10000 },
        text_policy_id: { type: "string", minLength: 1, maxLength: 256 },
        text_policy_revision: { type: "string", minLength: 1, maxLength: 256 },
        image_size_bytes: { type: "integer", minimum: 1 },
        image_max_bytes: { type: "integer", minimum: 1, maximum: 26214400 },
        image_media_type: { enum: ["image/png"] },
        image_width: { type: "integer", minimum: 0 },
        image_height: { type: "integer", minimum: 0 }
      }
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
        "social_post_publish_failed",
        "social_post_provider_contract_invalid",
        "social_post_preparation_mismatch",
        "social_post_preparation_invalid"
      ]
    }
  },
  built_ins: {
    "social-post.apply_revision_scope": {
      id: "social-post.apply_revision_scope",
      input_schema: applyRevisionScopeInputSchema,
      output_schema: draftSchema
    },
    "social-post.prepare": {
      id: "social-post.prepare",
      input_schema: prepareInputSchema,
      output_schema: prepareOutputSchema,
      required_ports: ["social-post.provider"]
    },
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
