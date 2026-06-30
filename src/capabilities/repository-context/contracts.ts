import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);

export const RelatedContextConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    max_related_files: z.number().int().positive().optional(),
    max_scan_files: z.number().int().positive().optional(),
    max_file_bytes: z.number().int().positive().optional(),
    max_excerpt_bytes: z.number().int().positive().optional(),
    include_tests: z.boolean().optional(),
    include_docs: z.boolean().optional(),
    include_configs: z.boolean().optional()
  })
  .strict();
export type RelatedContextConfig = z.infer<typeof RelatedContextConfigSchema>;

const RelatedContextRelationSchema = z.enum([
  "changed_file",
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
    reason: NonEmptyStringSchema
  })
  .strict();
export type RelatedContextEdge = z.infer<typeof RelatedContextEdgeSchema>;

export const RelatedContextSchema = z
  .object({
    kind: z.literal("luna.related_context.v1"),
    schema_version: z.literal("1"),
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
    changed_files: z.array(NonEmptyStringSchema),
    query_terms: z.array(NonEmptyStringSchema),
    nodes: z.array(RelatedContextNodeSchema),
    edges: z.array(RelatedContextEdgeSchema),
    files: z.array(RelatedContextFileSchema),
    budgets: z
      .object({
        max_related_files: z.number().int().positive(),
        max_scan_files: z.number().int().positive(),
        max_file_bytes: z.number().int().positive(),
        max_excerpt_bytes: z.number().int().positive()
      })
      .strict(),
    truncation: z
      .object({
        omitted_paths: z.array(NonEmptyStringSchema),
        truncated_paths: z.array(NonEmptyStringSchema),
        unsupported_files: z.array(NonEmptyStringSchema)
      })
      .strict(),
    audit: z
      .object({
        enabled: z.boolean(),
        scanned_files: z.number().int().nonnegative(),
        skipped_files: z.number().int().nonnegative(),
        max_related_files: z.number().int().positive(),
        max_scan_files: z.number().int().positive(),
        max_file_bytes: z.number().int().positive(),
        max_excerpt_bytes: z.number().int().positive(),
        languages: z.array(NonEmptyStringSchema),
        symbol_engines: z.array(NonEmptyStringSchema),
        warnings: z.array(NonEmptyStringSchema)
      })
      .strict()
  })
  .strict();
export type RelatedContext = z.infer<typeof RelatedContextSchema>;
