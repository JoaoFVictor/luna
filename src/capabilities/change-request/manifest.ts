import { capabilityManifest } from "../../core/capabilities/manifest.js";

const changeRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "url"],
  properties: {
    id: { type: "string" },
    url: { type: "string" },
    title: { type: "string" }
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
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "source_branch"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          source_branch: { type: "string" },
          target_branch: { type: "string" }
        }
      },
      output_schema: changeRequestSchema,
      required_ports: ["change-request.provider"],
      side_effect_policy: "change-request.create_side_effect"
    }
  },
  policies: {
    "change-request.create_side_effect": {
      id: "change-request.create_side_effect",
      config_schema: {
        type: "object",
        additionalProperties: false,
        required: ["operation_id"],
        properties: {
          operation_id: { type: "string" }
        }
      },
      side_effect_semantics: "write",
      retry_semantics: "retry_requires_adoption",
      error_codes: ["change_request_unknown_create_outcome"]
    }
  },
  docs: [{ title: "Provider-agnostic change request operations" }]
});
