import { z } from "zod";
import { Buffer } from "node:buffer";
import { WorktreeDiffSchema } from "../git/diff/worktree-diff.js";
import {
  REPOSITORY_CONTEXT_DEFAULTS,
  REPOSITORY_CONTEXT_INPUT_LIMITS,
  REPOSITORY_CONTEXT_LIMITS,
  REPOSITORY_CONTEXT_OUTPUT_LIMITS
} from "./config-policy.js";

const NonEmptyStringSchema = z.string().min(1);
const boundedUtf8String = (maxBytes: number) => NonEmptyStringSchema
  .max(maxBytes)
  .refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes, {
    message: `String must not exceed ${maxBytes} UTF-8 bytes`
  });

export const RelatedContextConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    max_related_files: z.number().int().positive().max(REPOSITORY_CONTEXT_LIMITS.max_related_files).optional(),
    max_seed_files: z.number().int().positive().max(REPOSITORY_CONTEXT_LIMITS.max_seed_files).optional(),
    max_excerpt_bytes: z.number().int().positive().max(REPOSITORY_CONTEXT_LIMITS.max_excerpt_bytes).optional(),
    include_tests: z.boolean().optional(),
    include_docs: z.boolean().optional(),
    include_configs: z.boolean().optional()
  })
  .strict()
  .superRefine((config, context) => {
    if (
      config.max_seed_files !== undefined &&
      config.max_seed_files >
        (config.max_related_files ?? REPOSITORY_CONTEXT_DEFAULTS.max_related_files)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max_seed_files"],
        message: "max_seed_files must be less than or equal to max_related_files"
      });
    }
  });
export type RelatedContextConfig = z.infer<typeof RelatedContextConfigSchema>;

export const RelatedContextTaskSchema = z
  .object({
    text: boundedUtf8String(REPOSITORY_CONTEXT_INPUT_LIMITS.task_text_bytes),
    paths: z.array(boundedUtf8String(REPOSITORY_CONTEXT_INPUT_LIMITS.task_path_bytes))
      .max(REPOSITORY_CONTEXT_INPUT_LIMITS.task_paths).optional(),
    symbols: z.array(boundedUtf8String(REPOSITORY_CONTEXT_INPUT_LIMITS.task_symbol_bytes))
      .max(REPOSITORY_CONTEXT_INPUT_LIMITS.task_symbols).optional()
  })
  .strict();
export type RelatedContextTask = z.infer<typeof RelatedContextTaskSchema>;

export const RelatedContextConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    max_related_files: { type: "integer", minimum: 1, maximum: REPOSITORY_CONTEXT_LIMITS.max_related_files },
    max_seed_files: { type: "integer", minimum: 1, maximum: REPOSITORY_CONTEXT_LIMITS.max_seed_files },
    max_excerpt_bytes: { type: "integer", minimum: 1, maximum: REPOSITORY_CONTEXT_LIMITS.max_excerpt_bytes },
    include_tests: { type: "boolean" },
    include_docs: { type: "boolean" },
    include_configs: { type: "boolean" }
  }
} as const;

export const RelatedContextTaskJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: {
      type: "string", minLength: 1,
      maxLength: REPOSITORY_CONTEXT_INPUT_LIMITS.task_text_bytes
    },
    paths: {
      type: "array", maxItems: REPOSITORY_CONTEXT_INPUT_LIMITS.task_paths,
      items: {
        type: "string", minLength: 1,
        maxLength: REPOSITORY_CONTEXT_INPUT_LIMITS.task_path_bytes
      }
    },
    symbols: {
      type: "array", maxItems: REPOSITORY_CONTEXT_INPUT_LIMITS.task_symbols,
      items: {
        type: "string", minLength: 1,
        maxLength: REPOSITORY_CONTEXT_INPUT_LIMITS.task_symbol_bytes
      }
    }
  }
} as const;

export const RelatedContextWorktreeDiffSchema = z
  .object({
    diff: WorktreeDiffSchema,
    task: RelatedContextTaskSchema.optional()
  })
  .strict();
export type RelatedContextWorktreeDiff = z.infer<typeof RelatedContextWorktreeDiffSchema>;

const RelatedContextRelationSchema = z.enum([
  "changed_file",
  "task_seed",
  "query_match",
  "import_dependency",
  "reverse_reference",
  "test",
  "same_directory",
  "config",
  "docs",
  "similar_abstraction"
]);
export type RelatedContextRelation = z.infer<typeof RelatedContextRelationSchema>;

const RelatedContextFileSchema = z
  .object({
    path: NonEmptyStringSchema,
    relation: RelatedContextRelationSchema,
    language: NonEmptyStringSchema.optional(),
    score: z.number(),
    score_breakdown: z.record(z.number()),
    excerpt: z
      .object({
        start_line: z.number().int().positive(),
        end_line: z.number().int().positive(),
        content: z.string(),
        truncated: z.boolean().optional()
      })
      .strict()
      .nullable(),
    matched_terms: z.array(NonEmptyStringSchema),
    matched_symbols: z.array(NonEmptyStringSchema),
    reasons: z.array(NonEmptyStringSchema)
  })
  .strict();
export type RelatedContextFile = z.infer<typeof RelatedContextFileSchema>;

const RelatedContextNodeSchema = z
  .object({
    id: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
    kind: RelatedContextRelationSchema,
    language: NonEmptyStringSchema.optional(),
    source: NonEmptyStringSchema,
    reason: NonEmptyStringSchema,
    confidence: z.enum(["high", "medium", "low"])
  })
  .strict();
export type RelatedContextNode = z.infer<typeof RelatedContextNodeSchema>;

const RelatedContextEdgeSchema = z
  .object({
    from: NonEmptyStringSchema,
    to: NonEmptyStringSchema,
    type: z.enum([
      "imports",
      "includes",
      "requires",
      "references",
      "tests",
      "configured_by",
      "documents",
      "nearby",
      "similar_to"
    ]),
    reason: boundedUtf8String(REPOSITORY_CONTEXT_OUTPUT_LIMITS.edge_text_bytes)
  })
  .strict();
export type RelatedContextEdge = z.infer<typeof RelatedContextEdgeSchema>;

export const RelatedContextSchema = z
  .object({
    kind: z.literal("luna.repository_context.v2"),
    schema_version: z.literal("2"),
    source: z
      .object({
        kind: z.enum(["pull_request_diff", "task", "worktree_diff"])
      })
      .strict(),
    snapshot: z
      .object({
        id: NonEmptyStringSchema,
        head_sha: NonEmptyStringSchema,
        dirty: z.boolean(),
        indexer_version: NonEmptyStringSchema,
        policy_hash: NonEmptyStringSchema
      })
      .strict(),
    coverage: z
      .object({
        inventory_files: z.number().int().nonnegative(),
        eligible_files: z.number().int().nonnegative(),
        indexed_files: z.number().int().nonnegative(),
        excluded_files: z.number().int().nonnegative(),
        policy_excluded_files: z.number().int().nonnegative(),
        binary_excluded_files: z.number().int().nonnegative(),
        sensitive_excluded_files: z.number().int().nonnegative(),
        non_regular_excluded_files: z.number().int().nonnegative(),
        generic_text_files: z.number().int().nonnegative(),
        unavailable_files: z.number().int().nonnegative(),
        complete: z.boolean(),
        languages: z.array(NonEmptyStringSchema),
        symbol_engines: z.array(NonEmptyStringSchema)
      })
      .strict(),
    repository: z
      .object({
        owner: NonEmptyStringSchema,
        name: NonEmptyStringSchema,
        full_name: NonEmptyStringSchema
      })
      .strict(),
    base_sha: NonEmptyStringSchema,
    head_sha: NonEmptyStringSchema,
    merge_base: NonEmptyStringSchema.optional(),
    summary: NonEmptyStringSchema,
    seed_files: z.array(NonEmptyStringSchema),
    changed_files: z.array(NonEmptyStringSchema)
      .max(REPOSITORY_CONTEXT_OUTPUT_LIMITS.changed_files),
    query_terms: z.array(NonEmptyStringSchema).max(REPOSITORY_CONTEXT_OUTPUT_LIMITS.query_terms),
    nodes: z.array(RelatedContextNodeSchema),
    edges: z.array(RelatedContextEdgeSchema).max(REPOSITORY_CONTEXT_OUTPUT_LIMITS.edges),
    files: z.array(RelatedContextFileSchema),
    budgets: z
      .object({
        max_related_files: z.number().int().positive().max(REPOSITORY_CONTEXT_LIMITS.max_related_files),
        max_seed_files: z.number().int().positive().max(REPOSITORY_CONTEXT_LIMITS.max_seed_files),
        max_excerpt_bytes: z.number().int().positive().max(REPOSITORY_CONTEXT_LIMITS.max_excerpt_bytes)
      })
      .strict(),
    truncation: z
      .object({
        omitted_paths: z.array(NonEmptyStringSchema),
        omitted_count: z.number().int().nonnegative(),
        omitted_edges_count: z.number().int().nonnegative(),
        truncated_edge_text_count: z.number().int().nonnegative(),
        fuzzy_candidates_considered: z.number().int().nonnegative(),
        fuzzy_candidates_omitted: z.number().int().nonnegative(),
        posting_documents_considered: z.number().int().nonnegative(),
        posting_documents_omitted: z.number().int().nonnegative(),
        query_documents_omitted: z.number().int().nonnegative(),
        graph_edges_visited: z.number().int().nonnegative(),
        graph_edges_omitted: z.number().int().nonnegative(),
        graph_edges_omitted_lower_bound: z.boolean(),
        graph_matches_omitted: z.number().int().nonnegative(),
        graph_frontier_omitted: z.number().int().nonnegative(),
        score_states_omitted: z.number().int().nonnegative(),
        changed_files_omitted_count: z.number().int().nonnegative(),
        truncated_paths: z.array(NonEmptyStringSchema)
          .max(REPOSITORY_CONTEXT_OUTPUT_LIMITS.path_diagnostics),
        truncated_paths_omitted_count: z.number().int().nonnegative(),
        unsupported_files: z.array(NonEmptyStringSchema)
          .max(REPOSITORY_CONTEXT_OUTPUT_LIMITS.path_diagnostics),
        unsupported_files_omitted_count: z.number().int().nonnegative(),
        unseeded_changed_paths: z.array(NonEmptyStringSchema)
          .max(REPOSITORY_CONTEXT_OUTPUT_LIMITS.path_diagnostics),
        unseeded_changed_paths_omitted_count: z.number().int().nonnegative()
      })
      .strict(),
    audit: z
      .object({
        enabled: z.boolean(),
        scanned_files: z.number().int().nonnegative(),
        skipped_files: z.number().int().nonnegative(),
        max_related_files: z.number().int().positive().max(REPOSITORY_CONTEXT_LIMITS.max_related_files),
        max_seed_files: z.number().int().positive().max(REPOSITORY_CONTEXT_LIMITS.max_seed_files),
        max_excerpt_bytes: z.number().int().positive().max(REPOSITORY_CONTEXT_LIMITS.max_excerpt_bytes),
        languages: z.array(NonEmptyStringSchema),
        symbol_engines: z.array(NonEmptyStringSchema),
        warnings: z.array(NonEmptyStringSchema).max(REPOSITORY_CONTEXT_OUTPUT_LIMITS.warnings),
        warnings_omitted_count: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();
export type RelatedContext = z.infer<typeof RelatedContextSchema>;

export type RepositoryContextQuery = Pick<
  RelatedContext,
  "snapshot" | "coverage" | "summary" | "nodes" | "edges" | "files" |
  "budgets" | "truncation" | "audit"
> & {
  readonly kind: "luna.repository_context_query.v1";
  readonly schema_version: "1";
  readonly source: { readonly kind: "query" };
  readonly query: RelatedContextTask;
};
