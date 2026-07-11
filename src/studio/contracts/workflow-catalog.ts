import { z } from "zod";
import { StudioCatalogDiagnosticSchema } from "./catalog.js";
import { StudioCatalogReferenceSchema } from "./catalog-references.js";
import { StudioDigestSchema } from "./digests.js";

const NonEmptyStringSchema = z.string().min(1);

export const StudioWorkflowSummarySchema = z
  .object({
    id: NonEmptyStringSchema,
    mode: z.enum(["read_only", "trusted_local_write"]),
    revision: StudioDigestSchema,
    capabilities: z.array(NonEmptyStringSchema),
    registrations: z.array(NonEmptyStringSchema),
    agents: z.array(NonEmptyStringSchema),
    input_schema: StudioCatalogReferenceSchema,
    output_schema: StudioCatalogReferenceSchema,
    config: z
      .object({
        file: StudioCatalogReferenceSchema,
        schema: StudioCatalogReferenceSchema
      })
      .strict()
      .optional(),
    node_counts: z
      .object({
        built_in: z.number().int().nonnegative(),
        agent: z.number().int().nonnegative(),
        pattern: z.number().int().nonnegative(),
        human_gate: z.number().int().nonnegative()
      })
      .strict(),
    requires_repository: z.boolean(),
    max_concurrency: z.number().int().positive()
  })
  .strict();
export type StudioWorkflowSummary = z.infer<
  typeof StudioWorkflowSummarySchema
>;

export const StudioWorkflowCatalogSchema = z
  .object({
    status: z.enum(["complete", "partial"]),
    fingerprint: StudioDigestSchema,
    workflows: z.array(StudioWorkflowSummarySchema),
    diagnostics: z.array(StudioCatalogDiagnosticSchema)
  })
  .strict();
export type StudioWorkflowCatalog = z.infer<
  typeof StudioWorkflowCatalogSchema
>;
