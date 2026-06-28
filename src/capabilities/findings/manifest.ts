import { capabilityManifest } from "../../core/capabilities/manifest.js";

export const manifest = capabilityManifest({
  id: "findings",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "findings.validate_evidence": {
      id: "findings.validate_evidence",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["findings"],
        properties: {
          repo_context: {},
          findings: {}
        }
      },
      output_schema: {
        type: "object",
        additionalProperties: true
      },
      required_ports: []
    }
  },
  docs: [{ title: "Finding evidence validation" }]
});
