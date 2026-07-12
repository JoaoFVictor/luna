import { capabilityManifest } from "../../core/capabilities/manifest.js";

const emptyInputSchema = {
  type: "object",
  additionalProperties: false
} as const;

const objectOutputSchema = {
  type: "object",
  additionalProperties: true
} as const;

export const manifest = capabilityManifest({
  id: "task-context",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "task-context.collect": {
      id: "task-context.collect",
      presentation: {
        title: "Coletar dados da tarefa",
        summary: "Carrega o contexto normalizado da tarefa recebida pelo launcher.",
        category: "Contexto",
        tags: ["task", "launcher"]
      },
      input_schema: emptyInputSchema,
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "task-context.final_report": {
      id: "task-context.final_report",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          validation: {},
          commit: {},
          push: {},
          change_request: {}
        }
      },
      output_schema: objectOutputSchema,
      required_ports: []
    }
  },
  docs: [{ title: "Provider task context and task result reports" }]
});
