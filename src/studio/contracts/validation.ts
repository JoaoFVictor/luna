import { z } from "zod";
import { StudioDigestSchema } from "./digests.js";
import {
  StudioPathSchema,
  StudioResourceRefSchema
} from "./paths.js";

const NonEmptyBoundedStringSchema = z.string().min(1).max(2_000);
export const STUDIO_VALIDATION_FIELD_PATH_MAX_LENGTH = 1_024;
export const STUDIO_VALIDATION_CAPABILITY_MAX_LENGTH = 256;
const DiagnosticCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const StudioValidationDiagnosticSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    code: DiagnosticCodeSchema,
    message: NonEmptyBoundedStringSchema,
    resource: StudioResourceRefSchema,
    file: StudioPathSchema.optional(),
    field_path: z
      .string()
      .min(1)
      .max(STUDIO_VALIDATION_FIELD_PATH_MAX_LENGTH)
      .optional(),
    capability: z
      .string()
      .min(1)
      .max(STUDIO_VALIDATION_CAPABILITY_MAX_LENGTH)
      .optional(),
    node_id: z.string().min(1).max(256).optional(),
    edge: z.object({
      from: z.string().min(1).max(256),
      to: z.string().min(1).max(256)
    }).strict().optional()
  })
  .strict();
export type StudioValidationDiagnostic = z.infer<
  typeof StudioValidationDiagnosticSchema
>;

export const StudioCompiledWorkflowNodeSchema = z
  .object({
    id: z.string().min(1).max(256),
    kind: z.enum(["built_in", "agent", "pattern", "interrupt"]),
    yaml_path: z.string().min(1).max(1_024),
    capability_id: z.string().min(1).max(256),
    can_create_pending_interrupt: z.boolean()
  })
  .strict();
export type StudioCompiledWorkflowNode = z.infer<
  typeof StudioCompiledWorkflowNodeSchema
>;

export const StudioCompiledWorkflowEdgeSchema = z
  .object({
    from: z.string().min(1).max(256),
    to: z.string().min(1).max(256)
  })
  .strict();
export type StudioCompiledWorkflowEdge = z.infer<
  typeof StudioCompiledWorkflowEdgeSchema
>;

export const StudioCompiledWorkflowSchema = z
  .object({
    workflow_id: z.string().min(1).max(128),
    workflow_revision: StudioDigestSchema,
    state_schema_version: z.string().min(1).max(128),
    nodes: z.array(StudioCompiledWorkflowNodeSchema),
    edges: z.array(StudioCompiledWorkflowEdgeSchema)
  })
  .strict();
export type StudioCompiledWorkflow = z.infer<
  typeof StudioCompiledWorkflowSchema
>;

export const StudioResourceValidationSchema = z
  .object({
    resource: StudioResourceRefSchema,
    status: z.enum(["valid", "invalid"]),
    revision: StudioDigestSchema.optional(),
    diagnostics: z.array(StudioValidationDiagnosticSchema),
    compiled_workflow: StudioCompiledWorkflowSchema.optional()
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === "valid" && result.revision === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A valid Studio resource must include its revision",
        path: ["revision"]
      });
    }
    if (
      result.status === "invalid" &&
      !result.diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An invalid Studio resource must include an error diagnostic",
        path: ["diagnostics"]
      });
    }
    if (
      result.status === "valid" &&
      result.diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A valid Studio resource cannot include error diagnostics",
        path: ["diagnostics"]
      });
    }
    if (
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.resource.kind !== result.resource.kind ||
          diagnostic.resource.id !== result.resource.id
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Resource diagnostics must identify their owning resource",
        path: ["diagnostics"]
      });
    }
    if (
      result.compiled_workflow !== undefined &&
      result.resource.kind !== "workflow"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only workflow resources can include a compiled workflow",
        path: ["compiled_workflow"]
      });
    }
    if (
      result.compiled_workflow !== undefined &&
      (result.compiled_workflow.workflow_id !== result.resource.id ||
        result.compiled_workflow.workflow_revision !== result.revision)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Compiled workflow identity must match its resource revision",
        path: ["compiled_workflow"]
      });
    }
  });
export type StudioResourceValidation = z.infer<
  typeof StudioResourceValidationSchema
>;

export const StudioDraftValidationResultSchema = z
  .object({
    draft_id: z.string().uuid(),
    record_revision: z.number().int().safe().positive(),
    content_revision: z.number().int().safe().positive(),
    layout_revision: z.number().int().safe().nonnegative(),
    draft_hash: StudioDigestSchema,
    status: z.enum(["valid", "invalid"]),
    compiled: z.boolean(),
    resources: z.array(StudioResourceValidationSchema).min(1),
    diagnostics: z.array(StudioValidationDiagnosticSchema),
    validated_at: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine((result, context) => {
    const invalid = result.resources.some(
      (resource) => resource.status === "invalid"
    );
    if ((result.status === "invalid") !== invalid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Draft validation status must match its resource results",
        path: ["status"]
      });
    }
    const flattened = result.resources.flatMap(
      (resource) => resource.diagnostics
    );
    if (JSON.stringify(result.diagnostics) !== JSON.stringify(flattened)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Draft diagnostics must be the ordered resource diagnostics",
        path: ["diagnostics"]
      });
    }
    if (
      !result.compiled &&
      result.resources.some(
        (resource) => resource.compiled_workflow !== undefined
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Validate-only results cannot include compiled workflows",
        path: ["resources"]
      });
    }
    if (
      result.compiled &&
      result.resources.some(
        (resource) =>
          resource.resource.kind === "workflow" &&
          resource.status === "valid" &&
          resource.compiled_workflow === undefined
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A valid workflow compile result must include the compiled graph",
        path: ["resources"]
      });
    }
  });
export type StudioDraftValidationResult = z.infer<
  typeof StudioDraftValidationResultSchema
>;
