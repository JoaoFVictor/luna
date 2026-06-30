import { capabilityManifest } from "../../core/capabilities/manifest.js";

const relatedContextConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    max_related_files: { type: "integer", minimum: 1 },
    max_scan_files: { type: "integer", minimum: 1 },
    max_file_bytes: { type: "integer", minimum: 1 },
    max_excerpt_bytes: { type: "integer", minimum: 1 },
    include_tests: { type: "boolean" },
    include_docs: { type: "boolean" },
    include_configs: { type: "boolean" }
  }
} as const;

const relatedFileSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "path",
    "relation",
    "score",
    "score_breakdown",
    "excerpt",
    "matched_terms",
    "matched_symbols",
    "reasons"
  ],
  properties: {
    path: { type: "string", minLength: 1 },
    relation: {
      type: "string",
      enum: [
        "changed_file",
        "import_dependency",
        "reverse_reference",
        "test",
        "same_directory",
        "config",
        "docs",
        "similar_abstraction"
      ]
    },
    language: { type: "string", minLength: 1 },
    score: { type: "number" },
    score_breakdown: {
      type: "object",
      additionalProperties: { type: "number" }
    },
    excerpt: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["start_line", "end_line", "content"],
          properties: {
            start_line: { type: "integer", minimum: 1 },
            end_line: { type: "integer", minimum: 1 },
            content: { type: "string" },
            truncated: { type: "boolean" }
          }
        },
        { type: "null" }
      ]
    },
    matched_terms: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    matched_symbols: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    reasons: {
      type: "array",
      items: { type: "string", minLength: 1 }
    }
  }
} as const;

const relatedNodeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "path", "kind", "source", "reason", "confidence"],
  properties: {
    id: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
    kind: relatedFileSchema.properties.relation,
    language: { type: "string", minLength: 1 },
    source: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 },
    confidence: { type: "string", enum: ["high", "medium", "low"] }
  }
} as const;

const relatedEdgeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to", "type", "reason"],
  properties: {
    from: { type: "string", minLength: 1 },
    to: { type: "string", minLength: 1 },
    type: {
      type: "string",
      enum: [
        "imports",
        "includes",
        "requires",
        "references",
        "tests",
        "configured_by",
        "documents",
        "nearby",
        "similar_to"
      ]
    },
    reason: { type: "string", minLength: 1 }
  }
} as const;

const relatedContextOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "schema_version",
    "repository",
    "base_sha",
    "head_sha",
    "summary",
    "seed_files",
    "changed_files",
    "query_terms",
    "nodes",
    "edges",
    "files",
    "budgets",
    "truncation",
    "audit"
  ],
  properties: {
    kind: { const: "luna.related_context.v1" },
    schema_version: { const: "1" },
    repository: {
      type: "object",
      additionalProperties: false,
      required: ["owner", "name", "full_name"],
      properties: {
        owner: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        full_name: { type: "string", minLength: 1 }
      }
    },
    base_sha: { type: "string", minLength: 1 },
    head_sha: { type: "string", minLength: 1 },
    merge_base: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    seed_files: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    changed_files: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    query_terms: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    nodes: {
      type: "array",
      items: relatedNodeSchema
    },
    edges: {
      type: "array",
      items: relatedEdgeSchema
    },
    files: {
      type: "array",
      items: relatedFileSchema
    },
    budgets: {
      type: "object",
      additionalProperties: false,
      required: [
        "max_related_files",
        "max_scan_files",
        "max_file_bytes",
        "max_excerpt_bytes"
      ],
      properties: {
        max_related_files: { type: "integer", minimum: 1 },
        max_scan_files: { type: "integer", minimum: 1 },
        max_file_bytes: { type: "integer", minimum: 1 },
        max_excerpt_bytes: { type: "integer", minimum: 1 }
      }
    },
    truncation: {
      type: "object",
      additionalProperties: false,
      required: ["omitted_paths", "truncated_paths", "unsupported_files"],
      properties: {
        omitted_paths: {
          type: "array",
          items: { type: "string", minLength: 1 }
        },
        truncated_paths: {
          type: "array",
          items: { type: "string", minLength: 1 }
        },
        unsupported_files: {
          type: "array",
          items: { type: "string", minLength: 1 }
        }
      }
    },
    audit: {
      type: "object",
      additionalProperties: false,
      required: [
        "enabled",
        "scanned_files",
        "skipped_files",
        "max_related_files",
        "max_scan_files",
        "max_file_bytes",
        "max_excerpt_bytes",
        "languages",
        "symbol_engines",
        "warnings"
      ],
      properties: {
        enabled: { type: "boolean" },
        scanned_files: { type: "integer", minimum: 0 },
        skipped_files: { type: "integer", minimum: 0 },
        max_related_files: { type: "integer", minimum: 1 },
        max_scan_files: { type: "integer", minimum: 1 },
        max_file_bytes: { type: "integer", minimum: 1 },
        max_excerpt_bytes: { type: "integer", minimum: 1 },
        languages: {
          type: "array",
          items: { type: "string", minLength: 1 }
        },
        symbol_engines: {
          type: "array",
          items: { type: "string", minLength: 1 }
        },
        warnings: {
          type: "array",
          items: { type: "string", minLength: 1 }
        }
      }
    }
  }
} as const;

export const manifest = capabilityManifest({
  id: "repository-context",
  kind: "execution",
  version: "2026.06.29",
  built_ins: {
    "repository-context.related_context": {
      id: "repository-context.related_context",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["repo_context"],
        properties: {
          repo_context: {},
          config: relatedContextConfigSchema
        }
      },
      output_schema: relatedContextOutputSchema,
      required_ports: []
    }
  },
  docs: [{ title: "Repository impact context for code review" }]
});
