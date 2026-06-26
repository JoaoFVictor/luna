import { capabilityManifest } from "../../core/capabilities/manifest.js";

const emptyInputSchema = {
  type: "object",
  additionalProperties: false
} as const;

export const manifest = capabilityManifest({
  id: "repository",
  kind: "execution",
  version: "2026.06.25",
  tools: {
    "repository.status": {
      id: "repository.status",
      protocol: "local",
      input_schema: emptyInputSchema,
      output_schema: { type: "string" },
      runtime_requirements: ["tool_calling"],
      materialization: "local"
    },
    "repository.diff-summary": {
      id: "repository.diff-summary",
      protocol: "local",
      input_schema: emptyInputSchema,
      output_schema: { type: "string" },
      runtime_requirements: ["tool_calling"],
      materialization: "local"
    }
  },
  docs: [{ title: "Repository read-only local tools" }]
});
