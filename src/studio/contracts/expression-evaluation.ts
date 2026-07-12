import { z } from "zod";
import {
  boundedStudioJsonValueSchema,
  type StudioJsonLimits
} from "./bounded-json.js";

export const STUDIO_EXPRESSION_MAX_LENGTH = 8 * 1_024;
export const STUDIO_EXPRESSION_TIMEOUT_MS = 500;
export const STUDIO_EXPRESSION_RESULT_MAX_BYTES = 256 * 1_024;

export const STUDIO_EXPRESSION_FIXTURE_LIMITS: StudioJsonLimits = {
  maxBytes: 128 * 1_024,
  maxDepth: 32,
  maxEntries: 4_096,
  maxKeyLength: 256
};

export const STUDIO_EXPRESSION_RESULT_LIMITS: StudioJsonLimits = {
  maxBytes: STUDIO_EXPRESSION_RESULT_MAX_BYTES,
  maxDepth: 32,
  maxEntries: 8_192,
  maxKeyLength: 256
};

export const StudioExpressionFixtureSchema = boundedStudioJsonValueSchema(
  STUDIO_EXPRESSION_FIXTURE_LIMITS
);

export const StudioExpressionEvaluationRequestSchema = z
  .object({
    expression: z.string().min(1).max(STUDIO_EXPRESSION_MAX_LENGTH),
    fixture: StudioExpressionFixtureSchema
  })
  .strict();
export type StudioExpressionEvaluationRequest = z.infer<
  typeof StudioExpressionEvaluationRequestSchema
>;

export const StudioExpressionDiagnosticSchema = z
  .object({
    severity: z.literal("error"),
    code: z.enum([
      "expression_cancelled",
      "expression_evaluation_failed",
      "expression_invalid",
      "expression_result_invalid",
      "expression_timeout"
    ]),
    message: z.string().min(1).max(256),
    expression_path: z.literal("$.expression")
  })
  .strict();
export type StudioExpressionDiagnostic = z.infer<
  typeof StudioExpressionDiagnosticSchema
>;

const StudioExpressionResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("json"),
      value: boundedStudioJsonValueSchema(STUDIO_EXPRESSION_RESULT_LIMITS)
    })
    .strict(),
  z.object({ kind: z.literal("undefined") }).strict()
]);

export const StudioExpressionEvaluationSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("evaluated"),
        result: StudioExpressionResultSchema,
        diagnostics: z.tuple([])
      })
      .strict(),
    z
      .object({
        status: z.literal("error"),
        result: z.null(),
        diagnostics: z.tuple([StudioExpressionDiagnosticSchema])
      })
      .strict()
  ]
);
export type StudioExpressionEvaluation = z.infer<
  typeof StudioExpressionEvaluationSchema
>;
