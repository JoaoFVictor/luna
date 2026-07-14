import {
  REPOSITORY_CONTEXT_INPUT_LIMITS,
  REPOSITORY_CONTEXT_LIMITS,
  REPOSITORY_CONTEXT_OUTPUT_LIMITS
} from "./config-policy.js";
import { RelatedContextTaskJsonSchema } from "./contracts.js";

const MAX_PATH_LENGTH = REPOSITORY_CONTEXT_INPUT_LIMITS.task_path_bytes;
const MAX_DETAIL_LENGTH = REPOSITORY_CONTEXT_INPUT_LIMITS.task_text_bytes;
const MAX_DETAIL_ITEMS = 10_000;
const MAX_METADATA_ITEMS = REPOSITORY_CONTEXT_OUTPUT_LIMITS.path_diagnostics;
const MAX_OMITTED_PATHS = 50;

const boundedString = (maxLength: number) => ({
  type: "string" as const,
  minLength: 1,
  maxLength
});

const boundedStringArray = (maxItems: number, maxLength: number) => ({
  type: "array" as const,
  maxItems,
  items: boundedString(maxLength)
});

const RelatedContextRelationJsonSchema = {
  type: "string",
  enum: [
    "changed_file", "task_seed", "query_match", "import_dependency",
    "reverse_reference", "test", "same_directory", "config", "docs",
    "similar_abstraction"
  ]
} as const;

const RelatedContextFileJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "path", "relation", "score", "score_breakdown", "excerpt",
    "matched_terms", "matched_symbols", "reasons"
  ],
  properties: {
    path: boundedString(MAX_PATH_LENGTH),
    relation: RelatedContextRelationJsonSchema,
    language: boundedString(MAX_PATH_LENGTH),
    score: { type: "number" },
    score_breakdown: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        RelatedContextRelationJsonSchema.enum.map((relation) => [relation, { type: "number" }])
      )
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
            content: { type: "string", maxLength: REPOSITORY_CONTEXT_LIMITS.max_excerpt_bytes },
            truncated: { type: "boolean" }
          }
        },
        { type: "null" }
      ]
    },
    matched_terms: boundedStringArray(MAX_DETAIL_ITEMS, MAX_DETAIL_LENGTH),
    matched_symbols: boundedStringArray(MAX_DETAIL_ITEMS, MAX_DETAIL_LENGTH),
    reasons: boundedStringArray(MAX_DETAIL_ITEMS, MAX_DETAIL_LENGTH)
  }
} as const;

const RelatedContextNodeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "path", "kind", "source", "reason", "confidence"],
  properties: {
    id: boundedString(MAX_PATH_LENGTH),
    path: boundedString(MAX_PATH_LENGTH),
    kind: RelatedContextRelationJsonSchema,
    language: boundedString(MAX_PATH_LENGTH),
    source: boundedString(MAX_DETAIL_LENGTH),
    reason: boundedString(MAX_DETAIL_LENGTH),
    confidence: { type: "string", enum: ["high", "medium", "low"] }
  }
} as const;

const RelatedContextEdgeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to", "type", "reason"],
  properties: {
    from: boundedString(MAX_PATH_LENGTH),
    to: boundedString(MAX_PATH_LENGTH),
    type: {
      type: "string",
      enum: [
        "imports", "includes", "requires", "references", "tests",
        "configured_by", "documents", "nearby", "similar_to"
      ]
    },
    reason: boundedString(REPOSITORY_CONTEXT_OUTPUT_LIMITS.edge_text_bytes)
  }
} as const;

const SnapshotJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "head_sha", "dirty", "indexer_version", "policy_hash"],
  properties: {
    id: boundedString(MAX_PATH_LENGTH),
    head_sha: boundedString(128),
    dirty: { type: "boolean" },
    indexer_version: boundedString(128),
    policy_hash: boundedString(128)
  }
} as const;

const CoverageJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "inventory_files", "eligible_files", "indexed_files", "excluded_files",
    "policy_excluded_files", "binary_excluded_files", "sensitive_excluded_files",
    "non_regular_excluded_files", "generic_text_files", "unavailable_files",
    "complete", "languages", "symbol_engines"
  ],
  properties: {
    inventory_files: { type: "integer", minimum: 0 },
    eligible_files: { type: "integer", minimum: 0 },
    indexed_files: { type: "integer", minimum: 0 },
    excluded_files: { type: "integer", minimum: 0 },
    policy_excluded_files: { type: "integer", minimum: 0 },
    binary_excluded_files: { type: "integer", minimum: 0 },
    sensitive_excluded_files: { type: "integer", minimum: 0 },
    non_regular_excluded_files: { type: "integer", minimum: 0 },
    generic_text_files: { type: "integer", minimum: 0 },
    unavailable_files: { type: "integer", minimum: 0 },
    complete: { type: "boolean" },
    languages: boundedStringArray(MAX_METADATA_ITEMS, MAX_PATH_LENGTH),
    symbol_engines: boundedStringArray(MAX_METADATA_ITEMS, MAX_PATH_LENGTH)
  }
} as const;

const BudgetsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["max_related_files", "max_seed_files", "max_excerpt_bytes"],
  properties: {
    max_related_files: {
      type: "integer", minimum: 1, maximum: REPOSITORY_CONTEXT_LIMITS.max_related_files
    },
    max_seed_files: {
      type: "integer", minimum: 1, maximum: REPOSITORY_CONTEXT_LIMITS.max_seed_files
    },
    max_excerpt_bytes: {
      type: "integer", minimum: 1, maximum: REPOSITORY_CONTEXT_LIMITS.max_excerpt_bytes
    }
  }
} as const;

const TruncationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "omitted_paths", "omitted_count", "omitted_edges_count",
    "truncated_edge_text_count", "fuzzy_candidates_considered",
    "fuzzy_candidates_omitted", "posting_documents_considered",
    "posting_documents_omitted", "query_documents_omitted",
    "graph_edges_visited", "graph_edges_omitted", "graph_edges_omitted_lower_bound",
    "graph_matches_omitted",
    "graph_frontier_omitted", "score_states_omitted",
    "changed_files_omitted_count", "truncated_paths",
    "truncated_paths_omitted_count", "unsupported_files",
    "unsupported_files_omitted_count", "unseeded_changed_paths",
    "unseeded_changed_paths_omitted_count"
  ],
  properties: {
    omitted_paths: boundedStringArray(MAX_OMITTED_PATHS, MAX_PATH_LENGTH),
    omitted_count: { type: "integer", minimum: 0 },
    omitted_edges_count: { type: "integer", minimum: 0 },
    truncated_edge_text_count: { type: "integer", minimum: 0 },
    fuzzy_candidates_considered: { type: "integer", minimum: 0 },
    fuzzy_candidates_omitted: { type: "integer", minimum: 0 },
    posting_documents_considered: { type: "integer", minimum: 0 },
    posting_documents_omitted: { type: "integer", minimum: 0 },
    query_documents_omitted: { type: "integer", minimum: 0 },
    graph_edges_visited: { type: "integer", minimum: 0 },
    graph_edges_omitted: { type: "integer", minimum: 0 },
    graph_edges_omitted_lower_bound: { type: "boolean" },
    graph_matches_omitted: { type: "integer", minimum: 0 },
    graph_frontier_omitted: { type: "integer", minimum: 0 },
    score_states_omitted: { type: "integer", minimum: 0 },
    changed_files_omitted_count: { type: "integer", minimum: 0 },
    truncated_paths: boundedStringArray(MAX_METADATA_ITEMS, MAX_PATH_LENGTH),
    truncated_paths_omitted_count: { type: "integer", minimum: 0 },
    unsupported_files: boundedStringArray(MAX_METADATA_ITEMS, MAX_PATH_LENGTH),
    unsupported_files_omitted_count: { type: "integer", minimum: 0 },
    unseeded_changed_paths: boundedStringArray(MAX_METADATA_ITEMS, MAX_PATH_LENGTH),
    unseeded_changed_paths_omitted_count: { type: "integer", minimum: 0 }
  }
} as const;

const AuditJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "enabled", "scanned_files", "skipped_files", "max_related_files",
    "max_seed_files", "max_excerpt_bytes", "languages", "symbol_engines",
    "warnings", "warnings_omitted_count"
  ],
  properties: {
    enabled: { type: "boolean" },
    scanned_files: { type: "integer", minimum: 0 },
    skipped_files: { type: "integer", minimum: 0 },
    ...BudgetsJsonSchema.properties,
    languages: boundedStringArray(MAX_METADATA_ITEMS, MAX_PATH_LENGTH),
    symbol_engines: boundedStringArray(MAX_METADATA_ITEMS, MAX_PATH_LENGTH),
    warnings: boundedStringArray(REPOSITORY_CONTEXT_OUTPUT_LIMITS.warnings, MAX_DETAIL_LENGTH),
    warnings_omitted_count: { type: "integer", minimum: 0 }
  }
} as const;

const SharedViewProperties = {
  snapshot: SnapshotJsonSchema,
  coverage: CoverageJsonSchema,
  summary: boundedString(MAX_DETAIL_LENGTH),
  files: {
    type: "array", maxItems: REPOSITORY_CONTEXT_LIMITS.max_related_files,
    items: RelatedContextFileJsonSchema
  },
  nodes: {
    type: "array", maxItems: REPOSITORY_CONTEXT_LIMITS.max_related_files,
    items: RelatedContextNodeJsonSchema
  },
  edges: {
    type: "array", maxItems: REPOSITORY_CONTEXT_OUTPUT_LIMITS.edges,
    items: RelatedContextEdgeJsonSchema
  },
  budgets: BudgetsJsonSchema,
  truncation: TruncationJsonSchema,
  audit: AuditJsonSchema
} as const;

const SharedViewRequired = [
  "snapshot", "coverage", "summary", "files", "nodes", "edges", "budgets",
  "truncation", "audit"
] as const;

export const RelatedContextOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind", "schema_version", "source", ...SharedViewRequired, "repository",
    "base_sha", "head_sha", "seed_files", "changed_files", "query_terms"
  ],
  properties: {
    kind: { const: "luna.repository_context.v2" },
    schema_version: { const: "2" },
    source: {
      type: "object", additionalProperties: false, required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["pull_request_diff", "task", "worktree_diff"] }
      }
    },
    ...SharedViewProperties,
    repository: {
      type: "object", additionalProperties: false,
      required: ["owner", "name", "full_name"],
      properties: {
        owner: boundedString(MAX_PATH_LENGTH),
        name: boundedString(MAX_PATH_LENGTH),
        full_name: boundedString(MAX_PATH_LENGTH)
      }
    },
    base_sha: boundedString(128),
    head_sha: boundedString(128),
    merge_base: boundedString(128),
    seed_files: boundedStringArray(REPOSITORY_CONTEXT_LIMITS.max_seed_files, MAX_PATH_LENGTH),
    changed_files: boundedStringArray(REPOSITORY_CONTEXT_OUTPUT_LIMITS.changed_files, MAX_PATH_LENGTH),
    query_terms: boundedStringArray(REPOSITORY_CONTEXT_OUTPUT_LIMITS.query_terms, MAX_DETAIL_LENGTH)
  }
} as const;

export const RepositoryContextQueryOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind", "schema_version", "source", "query", ...SharedViewRequired
  ],
  properties: {
    kind: { const: "luna.repository_context_query.v1" },
    schema_version: { const: "1" },
    source: {
      type: "object", additionalProperties: false, required: ["kind"],
      properties: { kind: { const: "query" } }
    },
    query: RelatedContextTaskJsonSchema,
    ...SharedViewProperties
  }
} as const;
