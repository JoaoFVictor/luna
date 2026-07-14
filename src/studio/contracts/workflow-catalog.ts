import { z } from "zod";
import { StudioCatalogDiagnosticSchema } from "./catalog.js";
import { StudioCatalogReferenceSchema } from "./catalog-references.js";
import { StudioDigestSchema } from "./digests.js";
import { StudioJsonValueSchema } from "./json.js";

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
    input_schema_content: StudioJsonValueSchema,
    output_schema_content: StudioJsonValueSchema,
    synchronous_composition: z.enum(["allowed", "blocked"]),
    synchronous_composition_blocked_reason: z.literal("human_input").optional(),
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
        human_gate: z.number().int().nonnegative(),
        workflow: z.number().int().nonnegative(),
        loop: z.number().int().nonnegative()
      })
      .strict(),
    requires_repository: z.boolean(),
    max_concurrency: z.number().int().positive()
  })
  .strict()
  .superRefine((workflow, context) => {
    const blocked = workflow.synchronous_composition === "blocked";
    if (blocked !== (workflow.synchronous_composition_blocked_reason !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["synchronous_composition_blocked_reason"],
        message: "Blocked synchronous composition requires exactly one reason"
      });
    }
  });
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
