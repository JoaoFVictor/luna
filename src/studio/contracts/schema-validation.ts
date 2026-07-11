import { z } from "zod";
import {
  boundedStudioJsonObjectSchema,
  boundedStudioJsonValueSchema,
  type StudioJsonLimits
} from "./bounded-json.js";

export const STUDIO_SCHEMA_DIAGNOSTICS_MAX = 128;
export const STUDIO_SCHEMA_PATH_MAX_LENGTH = 2_048;
export const STUDIO_SCHEMA_VALIDATION_TIMEOUT_MS = 500;

export const STUDIO_SCHEMA_DOCUMENT_LIMITS: StudioJsonLimits = {
  maxBytes: 256 * 1_024,
  maxDepth: 32,
  maxEntries: 8_192,
  maxKeyLength: 256
};

export const STUDIO_SCHEMA_INSTANCE_LIMITS: StudioJsonLimits = {
  maxBytes: 256 * 1_024,
  maxDepth: 32,
  maxEntries: 8_192,
  maxKeyLength: 256
};

export const StudioSchemaValidationRequestSchema = z
  .object({
    schema: boundedStudioJsonObjectSchema(STUDIO_SCHEMA_DOCUMENT_LIMITS),
    instance: boundedStudioJsonValueSchema(STUDIO_SCHEMA_INSTANCE_LIMITS)
  })
  .strict();
export type StudioSchemaValidationRequest = z.infer<
  typeof StudioSchemaValidationRequestSchema
>;

export const StudioSchemaDiagnosticSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    code: z.enum([
      "diagnostics_truncated",
      "instance_schema_mismatch",
      "schema_invalid",
      "schema_keyword_unsupported",
      "schema_validation_cancelled",
      "schema_validation_failed",
      "schema_validation_timeout"
    ]),
    message: z.string().min(1).max(256),
    keyword: z.string().min(1).max(256).optional(),
    instance_path: z
      .string()
      .min(1)
      .max(STUDIO_SCHEMA_PATH_MAX_LENGTH)
      .optional(),
    schema_path: z
      .string()
      .min(1)
      .max(STUDIO_SCHEMA_PATH_MAX_LENGTH)
      .optional()
  })
  .strict();
export type StudioSchemaDiagnostic = z.infer<
  typeof StudioSchemaDiagnosticSchema
>;

export const StudioSchemaValidationSchema = z
  .object({
    status: z.enum(["valid", "invalid", "schema_invalid", "error"]),
    diagnostics: z
      .array(StudioSchemaDiagnosticSchema)
      .max(STUDIO_SCHEMA_DIAGNOSTICS_MAX)
  })
  .strict()
  .superRefine((result, context) => {
    const errors = result.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error"
    );
    if (result.status === "valid" && errors.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A valid schema result cannot include error diagnostics",
        path: ["diagnostics"]
      });
    }
    if (result.status !== "valid" && errors.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An invalid schema result must include an error diagnostic",
        path: ["diagnostics"]
      });
    }
    if (
      result.status === "schema_invalid" &&
      !errors.some((diagnostic) => diagnostic.code === "schema_invalid")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An invalid schema must include a schema diagnostic",
        path: ["diagnostics"]
      });
    }
    if (
      result.status === "invalid" &&
      !errors.some(
        (diagnostic) => diagnostic.code === "instance_schema_mismatch"
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An invalid instance must include a mismatch diagnostic",
        path: ["diagnostics"]
      });
    }
    if (
      result.status === "error" &&
      !errors.some((diagnostic) =>
        [
          "schema_validation_cancelled",
          "schema_validation_failed",
          "schema_validation_timeout"
        ].includes(diagnostic.code)
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A schema validation error must identify its boundary failure",
        path: ["diagnostics"]
      });
    }
  });
export type StudioSchemaValidation = z.infer<
  typeof StudioSchemaValidationSchema
>;
