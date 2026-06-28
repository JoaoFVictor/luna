import { capabilityManifest } from "../../core/capabilities/manifest.js";

const collectContextInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    base_sha: { type: "string" },
    head_sha: { type: "string" }
  }
} as const;

export const manifest = capabilityManifest({
  id: "repository-diff",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "repository-diff.collect_context": {
      id: "repository-diff.collect_context",
      input_schema: collectContextInputSchema,
      output_schema: {
        type: "object",
        additionalProperties: true
      },
      required_ports: []
    }
  },
  docs: [{ title: "Repository diff context collection" }]
});
