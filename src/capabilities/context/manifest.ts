import { capabilityManifest } from "../../core/capabilities/manifest.js";

const contextInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    agents: {
      type: "array",
      items: { type: "string" }
    },
    max_file_bytes: { type: "integer", minimum: 1 }
  }
} as const;

const contextOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "repository", "agents"],
  properties: {
    kind: { enum: ["luna.collect_context.v1"] },
    repository: {
      type: "object",
      additionalProperties: false,
      required: ["root", "configured", "read", "missing", "skipped"],
      properties: {
        root: { type: "string" },
        configured: {
          type: "array",
          items: { type: "string" }
        },
        read: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true
          }
        },
        missing: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true
          }
        },
        skipped: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true
          }
        }
      }
    },
    agents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "root", "configured", "read", "missing", "skipped"],
        properties: {
          id: { type: "string" },
          root: { type: "string" },
          configured: {
            type: "array",
            items: { type: "string" }
          },
          read: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true
            }
          },
          missing: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true
            }
          },
          skipped: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true
            }
          }
        }
      }
    }
  }
} as const;

export const manifest = capabilityManifest({
  id: "context",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "context.collect_context": {
      id: "context.collect_context",
      input_schema: contextInputSchema,
      output_schema: contextOutputSchema,
      required_ports: []
    }
  },
  docs: [{ title: "Deterministic repository and agent context intake" }]
});
