import { capabilityManifest } from "../../core/capabilities/manifest.js";

export const manifest = capabilityManifest({
  id: "reports",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "reports.final_report": {
      id: "reports.final_report",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["sections"],
        properties: {
          title: { type: "string" },
          sections: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["heading", "content"],
              properties: {
                heading: { type: "string" },
                content: { type: "string" }
              }
            }
          }
        }
      },
      output_schema: {
        type: "object",
        additionalProperties: false,
        required: ["report"],
        properties: {
          report: { type: "string" },
          artifact_refs: {
            type: "array",
            items: { type: "string" }
          }
        }
      },
      required_ports: []
    }
  },
  docs: [{ title: "Final workflow reports" }]
});
