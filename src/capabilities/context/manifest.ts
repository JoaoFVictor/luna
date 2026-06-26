import { capabilityManifest } from "../../core/capabilities/manifest.js";

const contextInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    repository: { type: "string" },
    context_files: {
      type: "array",
      items: { type: "string" }
    },
    agent_id: { type: "string" }
  }
} as const;

const contextOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["instructions", "context_audit"],
  properties: {
    instructions: { type: "string" },
    context_audit: {
      type: "object",
      additionalProperties: false,
      required: ["files"],
      properties: {
        files: {
          type: "array",
          items: { type: "string" }
        }
      }
    }
  }
} as const;

export const manifest = capabilityManifest({
  id: "context",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "context.collect_context": {
      id: "context.collect_context",
      input_schema: contextInputSchema,
      output_schema: contextOutputSchema,
      required_ports: []
    }
  },
  docs: [{ title: "Deterministic repository and agent context intake" }]
});
