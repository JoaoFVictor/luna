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
  id: "repository-change",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "repository-change.prepare_worktree": {
      id: "repository-change.prepare_worktree",
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
    "repository-change.record_validation": {
      id: "repository-change.record_validation",
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
    "repository-change.collect_worktree_diff": {
      id: "repository-change.collect_worktree_diff",
      input_schema: emptyInputSchema,
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "repository-change.record_acceptance_decision": {
      id: "repository-change.record_acceptance_decision",
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
    "repository-change.prepare_commit": {
      id: "repository-change.prepare_commit",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: {
          validation: {},
          acceptance: {},
          approved_snapshot: {},
          diff: {},
          message: { type: "string" }
        }
      },
      output_schema: objectOutputSchema,
      required_ports: []
    },
    "repository-change.record_commit_lifecycle": {
      id: "repository-change.record_commit_lifecycle",
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
    "repository-change.prepare_push": {
      id: "repository-change.prepare_push",
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
    "repository-change.record_push_lifecycle": {
      id: "repository-change.record_push_lifecycle",
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
    }
  },
  docs: [{ title: "Trusted local repository change lifecycle built-ins" }]
});
