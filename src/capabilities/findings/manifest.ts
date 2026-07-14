import { capabilityManifest } from "../../core/capabilities/manifest.js";
import { RepoContextJsonSchema } from "../git/diff/repo-context-json-schema.js";

const reviewedRangeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "line_start", "line_end"],
  properties: {
    path: { type: "string", minLength: 1 },
    line_start: { type: "integer", minimum: 1 },
    line_end: { type: "integer", minimum: 1 },
    notes: { type: "string", minLength: 1 },
    risk_tags: {
      type: "array",
      items: { type: "string", minLength: 1 }
    }
  }
} as const;

const evidenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "line_start", "line_end"],
  properties: {
    path: { type: "string", minLength: 1 },
    line_start: { type: "integer", minimum: 1 },
    line_end: { type: "integer", minimum: 1 },
    quote: { type: "string" }
  }
} as const;

const findingSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "severity",
    "confidence",
    "description",
    "evidence",
    "recommendation"
  ],
  properties: {
    title: { type: "string", minLength: 1 },
    severity: {
      type: "string",
      enum: ["critical", "high", "medium", "low", "info"]
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"]
    },
    description: { type: "string", minLength: 1 },
    evidence: {
      type: "array",
      items: evidenceSchema
    },
    recommendation: { type: "string", minLength: 1 },
    category: {
      type: "string",
      enum: [
        "security",
        "architecture",
        "bug",
        "maintainability",
        "compatibility",
        "other"
      ]
    },
    fingerprint: { type: "string", minLength: 1 },
    sources: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    merged_from: { type: "integer", minimum: 1 }
  }
} as const;

const findingsReviewOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "reviewed_ranges"],
  properties: {
    summary: {
      type: "string"
    },
    reviewed_ranges: {
      type: "array",
      items: reviewedRangeSchema
    },
    findings: {
      type: "array",
      items: findingSchema
    }
  }
} as const;

export const manifest = capabilityManifest({
  id: "findings",
  kind: "execution",
  version: "2026.06.25",
  schemas: {
    "findings.review_output": {
      id: "findings.review_output",
      schema: findingsReviewOutputSchema
    }
  },
  built_ins: {
    "findings.merge": {
      id: "findings.merge",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["sources"],
        properties: {
          sources: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "result"],
              properties: {
                id: {
                  type: "string",
                  minLength: 1
                },
                result: {
                  type: "object",
                  additionalProperties: false,
                  required: ["findings", "reviewed_ranges"],
                  properties: {
                    summary: {
                      type: "string"
                    },
                    findings: {
                      type: "array",
                      items: findingSchema
                    },
                    reviewed_ranges: {
                      type: "array",
                      items: reviewedRangeSchema
                    }
                  }
                }
              }
            }
          }
        }
      },
      output_schema: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "reviewed_ranges", "findings"],
        properties: {
          summary: { type: "string" },
          reviewed_ranges: {
            type: "array",
            items: reviewedRangeSchema
          },
          findings: {
            type: "array",
            items: findingSchema
          }
        }
      },
      required_ports: []
    },
    "findings.validate_evidence": {
      id: "findings.validate_evidence",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["findings"],
        properties: {
          repo_context: RepoContextJsonSchema,
          findings: {}
        }
      },
      output_schema: {
        type: "object",
        additionalProperties: false,
        required: ["findings"],
        properties: {
          summary: { type: "string" },
          findings: {
            type: "array",
            items: findingSchema
          }
        }
      },
      required_ports: []
    }
  },
  docs: [{ title: "Finding merge and evidence validation" }]
});
