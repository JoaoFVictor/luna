import { capabilityManifest } from "../../core/capabilities/manifest.js";

const objectOutputSchema = {
  type: "object",
  additionalProperties: true
} as const;

const emptyInputSchema = {
  type: "object",
  additionalProperties: false
} as const;

export const manifest = capabilityManifest({
  id: "runtime",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "runtime.preflight": {
      id: "runtime.preflight",
      presentation: {
        title: "Verificar ambiente",
        summary: "Confere requisitos do runtime antes de iniciar trabalho real.",
        category: "Validação",
        tags: ["preflight", "runtime"]
      },
      input_schema: emptyInputSchema,
      output_schema: objectOutputSchema,
      required_ports: []
    }
  },
  docs: [{ title: "Current Luna runtime built-ins" }]
});
