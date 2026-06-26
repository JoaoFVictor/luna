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
    "runtime.collect_worktree_diff": {
      id: "runtime.collect_worktree_diff",
      input_schema: emptyInputSchema,
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.commit_changes": {
      id: "runtime.commit_changes",
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
    "runtime.push_branch": {
      id: "runtime.push_branch",
      input_schema: emptyInputSchema,
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.open_change_request": {
      id: "runtime.open_change_request",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string" },
          description: {},
          source_branch: { type: "string" }
        }
      },
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "runtime.final_implementation_report": {
      id: "runtime.final_implementation_report",
      input_schema: emptyInputSchema,
      output_schema: objectOutputSchema,
      required_ports: []
    }
  },
  docs: [{ title: "Current Luna runtime built-ins" }]
});
