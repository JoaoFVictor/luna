import { capabilityManifest } from "../../core/capabilities/manifest.js";

const gitStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "operation_id",
    "workspace_id",
    "branch",
    "head_sha",
    "dirty",
    "staged_paths",
    "unstaged_paths",
    "untracked_paths"
  ],
  properties: {
    operation_id: { enum: ["git.status"] },
    workspace_id: { type: "string" },
    branch: { type: "string" },
    head_sha: { type: "string" },
    dirty: { type: "boolean" },
    staged_paths: {
      type: "array",
      items: { type: "string" }
    },
    unstaged_paths: {
      type: "array",
      items: { type: "string" }
    },
    untracked_paths: {
      type: "array",
      items: { type: "string" }
    }
  }
} as const;

const gitCommitSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "operation_id",
    "workspace_id",
    "branch",
    "head_sha",
    "commit_sha",
    "message",
    "adopted"
  ],
  properties: {
    operation_id: { enum: ["git.commit"] },
    workspace_id: { type: "string" },
    branch: { type: "string" },
    head_sha: { type: "string" },
    commit_sha: { type: "string" },
    message: { type: "string" },
    paths: {
      type: "array",
      items: { type: "string" }
    },
    adopted: { type: "boolean" }
  }
} as const;

const gitCommitSkippedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id", "enabled", "skipped", "reason"],
  properties: {
    operation_id: { enum: ["git.commit"] },
    enabled: { type: "boolean" },
    skipped: { const: true },
    reason: { type: "string" }
  }
} as const;

const gitPushBranchSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "operation_id",
    "workspace_id",
    "branch",
    "remote",
    "commit_sha",
    "pushed"
  ],
  properties: {
    operation_id: { enum: ["git.push_branch"] },
    workspace_id: { type: "string" },
    branch: { type: "string" },
    remote: { type: "string" },
    commit_sha: { type: "string" },
    pushed: { type: "boolean" }
  }
} as const;

const gitPushBranchSkippedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id", "enabled", "skipped", "reason"],
  properties: {
    operation_id: { enum: ["git.push_branch"] },
    enabled: { type: "boolean" },
    skipped: { const: true },
    reason: { type: "string" }
  }
} as const;

const statusInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    operation_id: { enum: ["git.status"] }
  }
} as const;

const commitInputSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: {
        operation_id: { enum: ["git.commit"] },
        message: { type: "string" },
        paths: {
          type: "array",
          items: { type: "string" }
        },
        expected_branch: { type: "string" },
        expected_base_sha: { type: "string" },
        remote: { type: "string" },
        expected_remote_urls: {
          type: "array",
          items: { type: "string" }
        }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "skipped", "reason"],
      properties: {
        operation_id: { enum: ["git.commit"] },
        enabled: { type: "boolean" },
        skipped: { const: true },
        reason: { type: "string" }
      }
    }
  ]
} as const;

const pushBranchInputSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["branch", "remote", "expected_commit_sha"],
      properties: {
        operation_id: { enum: ["git.push_branch"] },
        branch: { type: "string" },
        remote: { type: "string" },
        expected_commit_sha: { type: "string" },
        expected_remote_urls: {
          type: "array",
          items: { type: "string" }
        }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "skipped", "reason"],
      properties: {
        operation_id: { enum: ["git.push_branch"] },
        enabled: { type: "boolean" },
        skipped: { const: true },
        reason: { type: "string" }
      }
    }
  ]
} as const;

const statusPolicySchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id"],
  properties: {
    operation_id: { enum: ["git.status"] }
  }
} as const;

const commitPolicySchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id"],
  properties: {
    operation_id: { enum: ["git.commit"] }
  }
} as const;

const pushBranchPolicySchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id"],
  properties: {
    operation_id: { enum: ["git.push_branch"] }
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
        properties: {}
      },
      lifecycle: ["validate"],
      error_codes: ["git_command_failed", "git_conflict", "git_remote_unavailable"]
    }
  },
  built_ins: {
    "git.status": {
      id: "git.status",
      input_schema: statusInputSchema,
      output_schema: gitStatusSchema,
      required_ports: ["git.repository"],
      side_effect_policy: "git.status_read_policy"
    },
    "git.commit": {
      id: "git.commit",
      input_schema: commitInputSchema,
      output_schema: { oneOf: [gitCommitSchema, gitCommitSkippedSchema] },
      required_ports: ["git.repository"],
      side_effect_policy: "git.commit_side_effect"
    },
    "git.push_branch": {
      id: "git.push_branch",
      input_schema: pushBranchInputSchema,
      output_schema: {
        oneOf: [gitPushBranchSchema, gitPushBranchSkippedSchema]
      },
      required_ports: ["git.repository"],
      side_effect_policy: "git.push_branch_side_effect"
    }
  },
  policies: {
    "git.status_read_policy": {
      id: "git.status_read_policy",
      config_schema: statusPolicySchema,
      side_effect_semantics: "read",
      side_effect_category: "provider_read",
      side_effect_operation_ids: ["git.status"],
      idempotency_scope: "attempt",
      retry_semantics: "replay_safe",
      error_codes: ["git_command_failed"]
    },
    "git.commit_side_effect": {
      id: "git.commit_side_effect",
      config_schema: commitPolicySchema,
      side_effect_semantics: "write",
      side_effect_category: "repository_write",
      side_effect_operation_ids: ["git.commit"],
      idempotency_scope: "attempt",
      retry_semantics: "retry_requires_adoption",
      error_codes: ["git_unknown_commit_outcome"]
    },
    "git.push_branch_side_effect": {
      id: "git.push_branch_side_effect",
      config_schema: pushBranchPolicySchema,
      side_effect_semantics: "write",
      side_effect_category: "repository_write",
      side_effect_operation_ids: ["git.push_branch"],
      idempotency_scope: "external_resource",
      retry_semantics: "retry_forbidden",
      error_codes: ["git_unknown_push_outcome"]
    }
  },
  docs: [{ title: "Provider-agnostic Git operations" }]
});
