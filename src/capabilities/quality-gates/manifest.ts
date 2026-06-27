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

const validationCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cmd", "args"],
  properties: {
    cmd: { type: "string" },
    args: {
      type: "array",
      items: { type: "string" }
    },
    cwd: { type: "string" },
    timeout_ms: { type: "number", minimum: 1 }
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
        required: ["worker", "gates"],
        properties: {
          worker: { type: "string" },
          gates: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "type"],
              properties: {
                id: { type: "string" },
                type: { type: "string" },
                input: { type: "object" },
                decision: {},
                block_when: { type: "object" },
                feedback: { type: "object" }
              }
            }
          },
          repair: {
            type: "object",
            additionalProperties: false,
            properties: {
              attempts: {}
            }
          }
        }
      },
      output_schema: {
        type: "object",
        additionalProperties: false,
        required: [
          "status",
          "attempts_exhausted",
          "attempts",
          "validation",
          "final_validation",
          "gates",
          "result"
        ],
        properties: {
          status: { enum: ["passed", "failed"] },
          attempts_exhausted: { type: "boolean" },
          attempts: { type: "array" },
          validation: { type: "object" },
          final_validation: { type: "object" },
          gates: { type: "array" },
          result: {
            type: "object",
            additionalProperties: true,
            required: ["status"],
            properties: {
              status: { type: "string" }
            }
          }
        }
      },
      expand: { type: "declaring_node_subgraph" },
      local_context_roots: ["$.gate"]
    }
  },
  gates: {
    "quality-gates.validation_commands": {
      id: "quality-gates.validation_commands",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["commands", "max_output_bytes"],
        properties: {
          commands: {
            type: "array",
            minItems: 1,
            items: validationCommandSchema
          },
          max_output_bytes: { type: "number", minimum: 1 }
        }
      },
      decision_schema: {
        type: "object",
        additionalProperties: false,
        required: ["passed"],
        properties: {
          passed: { type: "boolean" },
          feedback: repairFeedbackSchema
        }
      },
      output_schema: repairFeedbackSchema,
      local_context_roots: ["$.gate"],
      interrupt: "none",
      repair_feedback_schema: repairFeedbackSchema
    },
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
    },
    "quality-gates.non_empty_diff": {
      id: "quality-gates.non_empty_diff",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      },
      decision_schema: {
        type: "object",
        additionalProperties: false,
        required: ["passed"],
        properties: {
          passed: { type: "boolean" },
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
