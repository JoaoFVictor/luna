import { capabilityManifest } from "../../core/capabilities/manifest.js";

const workspaceRefSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "operation_id",
    "run_id",
    "repository_id",
    "workspace_id",
    "path",
    "preserved",
    "reason",
    "lifecycle",
    "captured_at",
    "adopted",
    "workspace",
    "lock"
  ],
  properties: {
    operation_id: { enum: ["repository-workspace.capture"] },
    run_id: { type: "string" },
    repository_id: { type: "string" },
    workspace_id: { type: "string" },
    path: { type: "string" },
    preserved: { type: "boolean" },
    reason: { type: "string" },
    lifecycle: {
      enum: ["active", "released", "failed", "cancelled", "timed_out"]
    },
    captured_at: { type: "string" },
    adopted: { type: "boolean" },
    artifact: {
      type: "object",
      additionalProperties: false,
      required: ["id", "uri"],
      properties: {
        id: { type: "string" },
        uri: { type: "string" }
      }
    },
    workspace: {
      type: "object",
      additionalProperties: false,
      required: [
        "operation_id",
        "run_id",
        "repository_id",
        "workspace_id",
        "path",
        "preserved",
        "reason",
        "lifecycle",
        "captured_at"
      ],
      properties: {
        operation_id: { enum: ["repository-workspace.capture"] },
        run_id: { type: "string" },
        repository_id: { type: "string" },
        workspace_id: { type: "string" },
        path: { type: "string" },
        preserved: { type: "boolean" },
        reason: { type: "string" },
        lifecycle: {
          enum: ["active", "released", "failed", "cancelled", "timed_out"]
        },
        captured_at: { type: "string" },
        artifact: {
          type: "object",
          additionalProperties: false,
          required: ["id", "uri"],
          properties: {
            id: { type: "string" },
            uri: { type: "string" }
          }
        }
      }
    },
    lock: {
      type: "object",
      additionalProperties: false,
      required: ["repository_id", "token", "lifecycle", "acquired_at"],
      properties: {
        repository_id: { type: "string" },
        token: { type: "string" },
        lifecycle: { enum: ["acquired", "released"] },
        acquired_at: { type: "string" },
        release_reason: {
          enum: ["success", "failure", "cancellation", "timeout"]
        }
      }
    }
  }
} as const;

const captureInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    operation_id: { enum: ["repository-workspace.capture"] },
    repository_id: { type: "string" },
    lock_timeout_ms: { type: "number", minimum: 1 }
  }
} as const;

const capturePolicySchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id"],
  properties: {
    operation_id: { enum: ["repository-workspace.capture"] }
  }
} as const;

export const manifest = capabilityManifest({
  id: "repository-workspace",
  kind: "execution",
  version: "2026.06.25",
  ports: {
    "repository-workspace.manager": {
      id: "repository-workspace.manager",
      capability: "repository-workspace",
      option_schema: {
        type: "object",
        additionalProperties: false,
        required: ["repository_id"],
        properties: {
          repository_id: { type: "string" },
          lock_timeout_ms: { type: "number", minimum: 1 }
        }
      },
      lifecycle: ["validate", "open", "close"],
      error_codes: ["workspace_unavailable", "workspace_lock_conflict"]
    },
    "repository-workspace.lock_manager": {
      id: "repository-workspace.lock_manager",
      capability: "repository-workspace",
      option_schema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      },
      lifecycle: ["validate", "open", "close"],
      error_codes: [
        "workspace_lock_conflict",
        "workspace_lock_release_failed"
      ]
    },
    "repository-workspace.event_sink": {
      id: "repository-workspace.event_sink",
      capability: "repository-workspace",
      option_schema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      },
      lifecycle: ["validate"],
      error_codes: ["workspace_event_emit_failed"]
    }
  },
  built_ins: {
    "repository-workspace.capture": {
      id: "repository-workspace.capture",
      input_schema: captureInputSchema,
      output_schema: workspaceRefSchema,
      required_ports: [
        "repository-workspace.manager",
        "repository-workspace.lock_manager",
        "repository-workspace.event_sink"
      ],
      side_effect_policy: "repository-workspace.capture_policy"
    }
  },
  policies: {
    "repository-workspace.capture_policy": {
      id: "repository-workspace.capture_policy",
      config_schema: capturePolicySchema,
      side_effect_semantics: "write",
      side_effect_operation_ids: ["repository-workspace.capture"],
      idempotency_scope: "run",
      retry_semantics: "retry_requires_adoption",
      error_codes: [
        "workspace_unavailable",
        "workspace_lock_conflict",
        "workspace_lock_release_failed"
      ]
    }
  },
  docs: [{ title: "Repository workspace capture, locks, and lifecycle" }]
});
