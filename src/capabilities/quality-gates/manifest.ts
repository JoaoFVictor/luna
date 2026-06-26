import { capabilityManifest } from "../../core/capabilities/manifest.js";

const repairFeedbackSchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string" },
    failed_checks: {
      type: "array",
      items: { type: "string" }
    }
  }
} as const;

export const manifest = capabilityManifest({
  id: "quality-gates",
  kind: "execution",
  version: "2026.06.25",
  patterns: {
    "quality-gates.gated_agent_loop": {
      id: "quality-gates.gated_agent_loop",
      declaring_node_type: "pattern",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["writer_agent", "gates"],
        properties: {
          writer_agent: { type: "string" },
          gates: {
            type: "array",
            minItems: 1,
            items: { type: "string" }
          },
          max_iterations: { type: "number", minimum: 1 }
        }
      },
      output_schema: {
        type: "object",
        additionalProperties: false,
        required: ["status", "iterations"],
        properties: {
          status: { enum: ["passed", "failed"] },
          iterations: { type: "number", minimum: 1 },
          output: { description: "Final writer output." }
        }
      },
      expand: { type: "declaring_node_subgraph" },
      local_context_roots: ["$.gate"]
    }
  },
  gates: {
    "quality-gates.agent_review": {
      id: "quality-gates.agent_review",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["review_agent", "subject"],
        properties: {
          review_agent: { type: "string" },
          subject: { description: "JSON value reviewed by the gate agent." }
        }
      },
      decision_schema: {
        type: "object",
        additionalProperties: false,
        required: ["decision"],
        properties: {
          decision: { enum: ["pass", "fail"] },
          feedback: repairFeedbackSchema
        }
      },
      output_schema: repairFeedbackSchema,
      local_context_roots: ["$.gate"],
      interrupt: "none",
      repair_feedback_schema: repairFeedbackSchema
    }
  },
  docs: [{ title: "Gated agent loop pattern and gate contracts" }]
});

