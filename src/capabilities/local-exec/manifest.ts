import { capabilityManifest } from "../../core/capabilities/manifest.js";

const commandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command", "args"],
  properties: {
    command: { type: "string" },
    args: {
      type: "array",
      items: { type: "string" }
    },
    cwd: { type: "string" },
    timeout_ms: { type: "number", minimum: 1 }
  }
} as const;

export const manifest = capabilityManifest({
  id: "local-exec",
  kind: "execution",
  version: "2026.06.25",
  ports: {
    "local-exec.command_runner": {
      id: "local-exec.command_runner",
      capability: "local-exec",
      option_schema: {
        type: "object",
        additionalProperties: false,
        required: ["mode"],
        properties: {
          mode: { enum: ["read_only", "trusted_local_write"] },
          allowlist: {
            type: "array",
            items: { type: "string" }
          }
        }
      },
      lifecycle: ["validate"],
      error_codes: ["command_rejected", "command_failed", "command_timed_out"]
    }
  },
  policies: {
    "local-exec.command_policy": {
      id: "local-exec.command_policy",
      config_schema: commandSchema,
      side_effect_semantics: "write",
      side_effect_operation_ids: ["local-exec.command"],
      idempotency_scope: "attempt",
      retry_semantics: "retry_requires_adoption",
      error_codes: ["command_rejected", "command_timed_out"]
    }
  },
  docs: [{ title: "Local command execution ports and policies" }]
});
