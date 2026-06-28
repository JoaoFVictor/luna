import { capabilityManifest } from "../../core/capabilities/manifest.js";

const commandSchemaProperties = {
  mode: { enum: ["read_only", "trusted_local_write"] },
  command: { type: "string" },
  args: {
    type: "array",
    items: { type: "string" }
  },
  cwd: { type: "string" },
  timeout_ms: { type: "number", minimum: 1 }
} as const;

const readCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id", "mode", "operation", "command", "args"],
  properties: {
    operation_id: { enum: ["local-exec.command.read"] },
    operation: { enum: ["read"] },
    ...commandSchemaProperties
  }
} as const;

const writeCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id", "mode", "operation", "command", "args"],
  properties: {
    operation_id: { enum: ["local-exec.command.write"] },
    operation: { enum: ["write"] },
    ...commandSchemaProperties
  }
} as const;

const readPolicySchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id"],
  properties: {
    operation_id: { enum: ["local-exec.command.read"] }
  }
} as const;

const writePolicySchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id"],
  properties: {
    operation_id: { enum: ["local-exec.command.write"] }
  }
} as const;

const outputRefSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["inline", "bytes"],
      properties: {
        inline: { type: "string" },
        bytes: { type: "number" }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["artifact", "bytes"],
      properties: {
        artifact: {
          type: "object",
          additionalProperties: false,
          required: ["id", "uri"],
          properties: {
            id: { type: "string" },
            uri: { type: "string" }
          }
        },
        bytes: { type: "number" }
      }
    }
  ]
} as const;

const commandOutputRequired = [
  "operation_id",
  "command",
  "args",
  "exit_code",
  "stdout",
  "stderr",
  "duration_ms",
  "timed_out"
] as const;

const commandOutputProperties = {
  command: { type: "string" },
  args: {
    type: "array",
    items: { type: "string" }
  },
  cwd: { type: "string" },
  exit_code: { type: "number" },
  stdout: outputRefSchema,
  stderr: outputRefSchema,
  duration_ms: { type: "number" },
  timed_out: { type: "boolean" }
} as const;

const readCommandOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: commandOutputRequired,
  properties: {
    operation_id: { enum: ["local-exec.command.read"] },
    ...commandOutputProperties
  }
} as const;

const writeCommandOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: commandOutputRequired,
  properties: {
    operation_id: { enum: ["local-exec.command.write"] },
    ...commandOutputProperties
  }
} as const;

const requiredCommandPorts = [
  "local-exec.command_port",
  "local-exec.artifact_publisher",
  "local-exec.event_sink"
] as const;

export const manifest = capabilityManifest({
  id: "local-exec",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "local-exec.command.read": {
      id: "local-exec.command.read",
      input_schema: readCommandSchema,
      output_schema: readCommandOutputSchema,
      required_ports: requiredCommandPorts,
      side_effect_policy: "local-exec.command_read_policy"
    },
    "local-exec.command.write": {
      id: "local-exec.command.write",
      input_schema: writeCommandSchema,
      output_schema: writeCommandOutputSchema,
      required_ports: requiredCommandPorts,
      side_effect_policy: "local-exec.command_write_policy"
    }
  },
  ports: {
    "local-exec.command_port": {
      id: "local-exec.command_port",
      capability: "local-exec",
      option_schema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      },
      lifecycle: ["validate"],
      error_codes: ["command_rejected", "command_failed", "command_timed_out"]
    },
    "local-exec.artifact_publisher": {
      id: "local-exec.artifact_publisher",
      capability: "local-exec",
      option_schema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      },
      lifecycle: ["validate"],
      error_codes: ["artifact_publish_failed"]
    },
    "local-exec.event_sink": {
      id: "local-exec.event_sink",
      capability: "local-exec",
      option_schema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      },
      lifecycle: ["validate"],
      error_codes: ["event_emit_failed"]
    }
  },
  policies: {
    "local-exec.command_read_policy": {
      id: "local-exec.command_read_policy",
      config_schema: readPolicySchema,
      side_effect_semantics: "read",
      side_effect_operation_ids: ["local-exec.command.read"],
      idempotency_scope: "attempt",
      retry_semantics: "replay_safe",
      error_codes: ["command_rejected", "command_timed_out"]
    },
    "local-exec.command_write_policy": {
      id: "local-exec.command_write_policy",
      config_schema: writePolicySchema,
      side_effect_semantics: "write",
      side_effect_operation_ids: ["local-exec.command.write"],
      idempotency_scope: "attempt",
      retry_semantics: "retry_requires_adoption",
      error_codes: ["command_rejected", "command_timed_out"]
    }
  },
  docs: [{ title: "Local command execution ports and policies" }]
});
