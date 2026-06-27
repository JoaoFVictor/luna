import { capabilityManifest } from "../../core/capabilities/manifest.js";

const emptyInputSchema = {
  type: "object",
  additionalProperties: false
} as const;

const objectOutputSchema = {
  type: "object",
  additionalProperties: true
} as const;

const taskSubjectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "title"],
  properties: {
    key: { type: "string" },
    title: { type: "string" }
  }
} as const;

export const manifest = capabilityManifest({
  id: "runtime",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "runtime.preflight": {
      id: "runtime.preflight",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          commands: {}
        }
      },
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.prepare_worktree": {
      id: "runtime.prepare_worktree",
      input_schema: emptyInputSchema,
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.collect_repo_context": {
      id: "runtime.collect_repo_context",
      input_schema: emptyInputSchema,
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.validate_code_review_findings": {
      id: "runtime.validate_code_review_findings",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["findings"],
        properties: {
          repo_context: {},
          findings: {}
        }
      },
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.final_code_review_report": {
      id: "runtime.final_code_review_report",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          findings: {},
          validated_findings: {},
          acceptance: {}
        }
      },
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.prepare_implementation_worktree": {
      id: "runtime.prepare_implementation_worktree",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["subject"],
        properties: {
          subject: taskSubjectSchema
        }
      },
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.collect_task_context": {
      id: "runtime.collect_task_context",
      input_schema: emptyInputSchema,
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.record_implementation_validation": {
      id: "runtime.record_implementation_validation",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["implementation"],
        properties: {
          implementation: {}
        }
      },
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.run_validation_commands": {
      id: "runtime.run_validation_commands",
      input_schema: emptyInputSchema,
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.collect_worktree_diff": {
      id: "runtime.collect_worktree_diff",
      input_schema: emptyInputSchema,
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.record_acceptance_decision": {
      id: "runtime.record_acceptance_decision",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["acceptance"],
        properties: {
          acceptance: {}
        }
      },
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.prepare_commit": {
      id: "runtime.prepare_commit",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: {
          validation: {},
          acceptance: {},
          diff: {},
          message: { type: "string" }
        }
      },
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.record_commit_lifecycle": {
      id: "runtime.record_commit_lifecycle",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["commit"],
        properties: {
          commit: {}
        }
      },
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.prepare_push": {
      id: "runtime.prepare_push",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["commit"],
        properties: {
          commit: {}
        }
      },
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.record_push_lifecycle": {
      id: "runtime.record_push_lifecycle",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["push"],
        properties: {
          push: {}
        }
      },
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.final_implementation_report": {
      id: "runtime.final_implementation_report",
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
  docs: [{ title: "Current Luna runtime built-ins" }]
});
