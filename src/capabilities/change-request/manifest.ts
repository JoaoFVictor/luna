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

const booleanOrExpressionSchema = {
  anyOf: [{ type: "boolean" }, expressionSchema]
} as const;

const sourceSchema = {
  anyOf: [
    expressionSchema,
    {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: booleanOrExpressionSchema,
        skipped: booleanOrExpressionSchema,
        branch: stringOrExpressionSchema,
        reason: stringOrExpressionSchema
      }
    }
  ]
} as const;

const changeRequestCreatedSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "operation_id",
    "enabled",
    "skipped",
    "provider",
    "provider_id",
    "external_id",
    "url",
    "title",
    "source_branch",
    "target_branch",
    "adopted"
  ],
  properties: {
    operation_id: { enum: ["change-request.create"] },
    enabled: { const: true },
    skipped: { const: false },
    provider: { type: "string" },
    provider_id: { type: "string" },
    external_id: { type: "string" },
    url: { type: "string" },
    title: { type: "string" },
    source_branch: { type: "string" },
    target_branch: { type: "string" },
    adopted: { type: "boolean" }
  }
} as const;

const changeRequestSkippedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id", "enabled", "skipped", "reason", "adopted"],
  properties: {
    operation_id: { enum: ["change-request.create"] },
    enabled: { type: "boolean" },
    skipped: { const: true },
    reason: { type: "string" },
    adopted: { const: false }
  }
} as const;

const changeRequestSchema = {
  oneOf: [changeRequestCreatedSchema, changeRequestSkippedSchema]
} as const;

const createInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "provider_id", "repository_path", "title", "target_branch"],
  anyOf: [{ required: ["source"] }, { required: ["source_branch"] }],
  properties: {
    operation_id: { enum: ["change-request.create"] },
    enabled: booleanOrExpressionSchema,
    provider_id: stringOrExpressionSchema,
    repository_path: stringOrExpressionSchema,
    title: stringOrExpressionSchema,
    description: stringOrExpressionSchema,
    source_branch: stringOrExpressionSchema,
    source: sourceSchema,
    target_branch: stringOrExpressionSchema,
    draft: booleanOrExpressionSchema
  }
} as const;

const createPolicySchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id"],
  properties: {
    operation_id: { enum: ["change-request.create"] }
  }
} as const;

export const manifest = capabilityManifest({
  id: "change-request",
  kind: "execution",
  version: "2026.06.25",
  ports: {
    "change-request.provider": {
      id: "change-request.provider",
      capability: "change-request",
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
        "change_request_auth_failed",
        "change_request_unavailable",
        "change_request_conflict"
      ]
    }
  },
  built_ins: {
    "change-request.create": {
      id: "change-request.create",
      input_schema: createInputSchema,
      output_schema: changeRequestSchema,
      required_ports: ["change-request.provider"],
      side_effect_policy: "change-request.create_side_effect"
    }
  },
  policies: {
    "change-request.create_side_effect": {
      id: "change-request.create_side_effect",
      config_schema: createPolicySchema,
      side_effect_semantics: "write",
      side_effect_category: "external_write",
      side_effect_operation_ids: ["change-request.create"],
      idempotency_scope: "attempt",
      retry_semantics: "retry_requires_adoption",
      error_codes: ["change_request_unknown_create_outcome"]
    }
  },
  docs: [{ title: "Provider-agnostic change request operations" }]
});
