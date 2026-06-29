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

const objectOrExpressionSchema = {
  anyOf: [{ type: "object" }, expressionSchema]
} as const;

const eventOrExpressionSchema = {
  anyOf: [{ enum: ["auto", "comment", "request_changes", "approve"] }, expressionSchema]
} as const;

export const publishAuthoringInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "provider_id", "repository_path", "pull_request", "body"],
  properties: {
    operation_id: { enum: ["pull-request-review.publish"] },
    enabled: booleanOrExpressionSchema,
    provider_id: stringOrExpressionSchema,
    repository_path: stringOrExpressionSchema,
    pull_request: objectOrExpressionSchema,
    event: eventOrExpressionSchema,
    body: stringOrExpressionSchema,
    acceptance: objectOrExpressionSchema,
    inline_comments: booleanOrExpressionSchema,
    findings: objectOrExpressionSchema,
    repo_context: objectOrExpressionSchema
  }
} as const;

const publishResultSchema = {
  oneOf: [
    {
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
        "event",
        "inline_comments",
        "fallback_comments"
      ],
      properties: {
        operation_id: { enum: ["pull-request-review.publish"] },
        enabled: { const: true },
        skipped: { const: false },
        provider: { type: "string" },
        provider_id: { type: "string" },
        external_id: { type: "string" },
        url: { type: "string" },
        event: { enum: ["comment", "request_changes", "approve"] },
        inline_comments: { type: "number" },
        fallback_comments: { type: "number" }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["operation_id", "enabled", "skipped", "reason"],
      properties: {
        operation_id: { enum: ["pull-request-review.publish"] },
        enabled: { type: "boolean" },
        skipped: { const: true },
        reason: { type: "string" },
        error: {
          type: "object",
          additionalProperties: false,
          required: ["message"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            details: {}
          }
        }
      }
    }
  ]
} as const;

const publishPolicySchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id"],
  properties: {
    operation_id: { enum: ["pull-request-review.publish"] }
  }
} as const;

export const manifest = capabilityManifest({
  id: "pull-request-review",
  kind: "execution",
  version: "2026.06.29",
  ports: {
    "pull-request-review.provider": {
      id: "pull-request-review.provider",
      capability: "pull-request-review",
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
        "pull_request_review_auth_failed",
        "pull_request_review_unavailable",
        "pull_request_review_conflict"
      ]
    }
  },
  built_ins: {
    "pull-request-review.publish": {
      id: "pull-request-review.publish",
      input_schema: publishAuthoringInputSchema,
      output_schema: publishResultSchema,
      required_ports: ["pull-request-review.provider"],
      side_effect_policy: "pull-request-review.publish_side_effect"
    }
  },
  policies: {
    "pull-request-review.publish_side_effect": {
      id: "pull-request-review.publish_side_effect",
      config_schema: publishPolicySchema,
      side_effect_semantics: "write",
      side_effect_operation_ids: ["pull-request-review.publish"],
      idempotency_scope: "attempt",
      retry_semantics: "retry_forbidden",
      error_codes: ["pull_request_review_unknown_publish_outcome"]
    }
  },
  docs: [{ title: "Provider-agnostic pull request review publishing" }]
});
