import { capabilityManifest } from "../../core/capabilities/manifest.js";

const validationCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cmd", "timeout_ms"],
  properties: {
    cmd: { type: "string" },
    args: {
      type: "array",
      items: { type: "string" }
    },
    timeout_ms: { type: "integer", minimum: 1 }
  }
} as const;

export const manifest = capabilityManifest({
  id: "validation",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "validation.run_commands": {
      id: "validation.run_commands",
      presentation: {
        title: "Executar validações",
        summary: "Roda comandos locais declarados, como testes e verificações.",
        category: "Validação",
        tags: ["test", "command"]
      },
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          commands: {
            type: "array",
            items: validationCommandSchema
          },
          max_output_bytes: { type: "integer", minimum: 1 },
          cwd: { type: "string" }
        }
      },
      output_schema: {
        type: "object",
        additionalProperties: true
      },
      required_ports: ["validation.runner"]
    }
  },
  ports: {
    "validation.runner": {
      id: "validation.runner",
      capability: "validation",
      option_schema: {
        type: "object",
        additionalProperties: false
      }
    }
  },
  docs: [{ title: "Reusable local validation command execution" }]
});
