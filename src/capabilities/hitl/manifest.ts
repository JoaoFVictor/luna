import { capabilityManifest } from "../../core/capabilities/manifest.js";
import {
  approvalRequiredInputSchema,
  approvalRequiredOutputSchema
} from "./built-ins.js";

const expressionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expression"],
  properties: { expression: { type: "string" } }
} as const;

const approveDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { const: "approve" },
    comment: { type: "string", minLength: 1, maxLength: 8192 }
  }
} as const;

const rejectDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { const: "reject" },
    comment: { type: "string", minLength: 1, maxLength: 8192 }
  }
} as const;

const requestChangesDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "comment", "targets"],
  properties: {
    action: { const: "request_changes" },
    comment: { type: "string", minLength: 1, maxLength: 8192 },
    targets: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 128 }
    }
  }
} as const;

const approvalDecisionSchema = {
  oneOf: [approveDecisionSchema, rejectDecisionSchema]
} as const;

const reviewDecisionSchema = {
  oneOf: [
    approveDecisionSchema,
    rejectDecisionSchema,
    requestChangesDecisionSchema
  ]
} as const;

export const manifest = capabilityManifest({
  id: "hitl",
  kind: "execution",
  version: "2026.07.12",
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
    },
    "hitl.review": {
      id: "hitl.review",
      input_schema: {
        type: "object",
        additionalProperties: true,
        required: ["review"],
        properties: {
          review: {
            type: "object",
            additionalProperties: false,
            required: ["targets"],
            properties: {
              approval: {
                type: "object",
                additionalProperties: false,
                required: ["allowed", "reason"],
                properties: {
                  allowed: {
                    anyOf: [{ type: "boolean" }, expressionSchema]
                  },
                  reason: {
                    anyOf: [
                      { type: "string", minLength: 1, maxLength: 2048 },
                      expressionSchema
                    ]
                  }
                }
              },
              targets: {
                type: "array",
                minItems: 1,
                maxItems: 32,
                uniqueItems: true,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "label"],
                  properties: {
                    id: { type: "string", minLength: 1, maxLength: 128 },
                    label: { type: "string", minLength: 1, maxLength: 256 }
                  }
                }
              }
            }
          }
        }
      },
      decision_schema: reviewDecisionSchema,
      output_schema: reviewDecisionSchema,
      interrupt: "required"
    }
  },
  docs: [{ title: "Human-in-the-loop approval gates" }]
});
