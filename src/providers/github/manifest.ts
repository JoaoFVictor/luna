import { capabilityManifest } from "../../core/capabilities/manifest.js";

const emptyInputSchema = {
  type: "object",
  additionalProperties: false
} as const;

const operationPolicySchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id"],
  properties: {
    operation_id: { type: "string" }
  }
} as const;

export const manifest = capabilityManifest({
  id: "pull-request-workspace",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "pull-request-workspace.prepare_worktree": {
      id: "pull-request-workspace.prepare_worktree",
      input_schema: emptyInputSchema,
      output_schema: {
        type: "object",
        additionalProperties: true
      },
      side_effect_policy: "pull-request-workspace.git_worktree",
      required_ports: []
    }
  },
  policies: {
    "pull-request-workspace.git_worktree": {
      id: "pull-request-workspace.git_worktree",
      config_schema: operationPolicySchema,
      side_effect_semantics: "write",
      side_effect_operation_ids: ["pull-request-workspace.prepare_worktree"],
      idempotency_scope: "run",
      retry_semantics: "retry_forbidden"
    }
  },
  docs: [{ title: "GitHub pull request workspace preparation" }]
});
