import { capabilityManifest } from "../../core/capabilities/manifest.js";
import {
  approvalRequiredInputSchema,
  approvalRequiredOutputSchema
} from "./built-ins.js";

const approvalDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["approved"],
  properties: {
    approved: { type: "boolean" },
    comment: { type: "string" }
  }
} as const;

export const manifest = capabilityManifest({
  id: "hitl",
  kind: "execution",
  version: "2026.06.28",
  built_ins: {
    "hitl.require_approval": {
      id: "hitl.require_approval",
      input_schema: approvalRequiredInputSchema,
      output_schema: approvalRequiredOutputSchema,
      required_ports: []
    }
  },
  gates: {
    "hitl.approval": {
      id: "hitl.approval",
      input_schema: {
        type: "object",
        additionalProperties: true
      },
      decision_schema: approvalDecisionSchema,
      output_schema: approvalDecisionSchema,
      interrupt: "required"
    }
  },
  docs: [{ title: "Human-in-the-loop approval gates" }]
});
