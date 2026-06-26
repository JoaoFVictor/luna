import { capabilityManifest } from "../../core/capabilities/manifest.js";

const gitRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sha"],
  properties: {
    sha: { type: "string" },
    branch: { type: "string" },
    remote: { type: "string" }
  }
} as const;

export const manifest = capabilityManifest({
  id: "git",
  kind: "execution",
  version: "2026.06.25",
  depends_on: ["repository-workspace"],
  ports: {
    "git.repository": {
      id: "git.repository",
      capability: "git",
      option_schema: {
        type: "object",
        additionalProperties: false,
        required: ["workspace_ref"],
        properties: {
          workspace_ref: { type: "string" }
        }
      },
      lifecycle: ["validate"],
      error_codes: ["git_command_failed", "git_conflict", "git_remote_unavailable"]
    }
  },
  built_ins: {
    "git.commit": {
      id: "git.commit",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: {
          message: { type: "string" },
          paths: {
            type: "array",
            items: { type: "string" }
          }
        }
      },
      output_schema: gitRefSchema,
      required_ports: ["git.repository"],
      side_effect_policy: "git.commit_side_effect"
    }
  },
  policies: {
    "git.commit_side_effect": {
      id: "git.commit_side_effect",
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
      error_codes: ["git_unknown_commit_outcome"]
    }
  },
  docs: [{ title: "Provider-agnostic Git operations" }]
});
