import { capabilityManifest } from "../../core/capabilities/manifest.js";

const validationCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cmd"],
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
    "validation.repository_configuration": {
      id: "validation.repository_configuration",
      presentation: {
        title: "Resolver validação do repositório",
        summary: "Usa a validação declarada pelo repositório ou nenhuma validação.",
        category: "Validação",
        tags: ["repository", "configuration"]
      },
      input_schema: {
        type: "object",
        additionalProperties: false
      },
      output_schema: {
        type: "object",
        additionalProperties: false,
        required: ["commands", "env_allowlist"],
        properties: {
          commands: {
            type: "array",
            items: validationCommandSchema
          },
          env_allowlist: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 }
          }
        }
      },
      required_ports: []
    },
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
        required: ["commands", "env_allowlist", "max_output_bytes"],
        properties: {
          commands: {
            type: "array",
            minItems: 1,
            items: validationCommandSchema
          },
          env_allowlist: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 }
          },
          max_output_bytes: { type: "integer", minimum: 1, maximum: 4 * 1024 * 1024 },
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
