import { z } from "zod";
import { StudioDigestSchema } from "./digests.js";
import { StudioJsonValueSchema } from "./json.js";
import { StudioCatalogReferenceSchema } from "./catalog-references.js";

export const StudioCatalogDiagnosticSchema = z
  .object({
    severity: z.enum(["warning", "error"]),
    code: z.string().min(1),
    message: z.string().min(1),
    resource_kind: z.enum(["agent", "capability", "workflow"]),
    resource_id: z.string().min(1)
  })
  .strict();
export type StudioCatalogDiagnostic = z.infer<
  typeof StudioCatalogDiagnosticSchema
>;

const StudioSubagentReferenceSchema = z
  .object({
    id: z.string().min(1),
    policy: z
      .object({
        mode: z.enum(["read_only", "trusted_local_write"]).optional(),
        allow_tools: z.array(z.string().min(1)).optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const StudioAgentCatalogItemSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    mode: z.enum(["read_only", "trusted_local_write"]),
    model_profile: z.string().min(1),
    output_schema_reference: StudioCatalogReferenceSchema,
    output_schema: StudioJsonValueSchema,
    skills: z.array(StudioCatalogReferenceSchema),
    tools: z.array(z.string().min(1)),
    mcp_servers: z.array(z.string().min(1)),
    subagents: z.array(StudioSubagentReferenceSchema),
    runtime_requirements: z.array(z.string().min(1)),
    preferred_runtime: z.string().min(1).optional(),
    runtime_order: z.array(z.string().min(1)),
    revision: StudioDigestSchema
  })
  .strict();
export type StudioAgentCatalogItem = z.infer<
  typeof StudioAgentCatalogItemSchema
>;

export const StudioAgentCatalogSchema = z
  .object({
    status: z.enum(["complete", "partial"]),
    fingerprint: StudioDigestSchema,
    agents: z.array(StudioAgentCatalogItemSchema),
    diagnostics: z.array(StudioCatalogDiagnosticSchema)
  })
  .strict();
export type StudioAgentCatalog = z.infer<typeof StudioAgentCatalogSchema>;
