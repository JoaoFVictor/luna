import { z } from "zod";
import {
  jsonValueBudgetViolation,
  type JsonValue,
  type JsonValueBudget,
  type JsonValueBudgetViolation
} from "../../core/json/value.js";
import { StudioJsonValueSchema } from "./json.js";

export type StudioJsonLimits = JsonValueBudget;

function budgetIssue(
  context: z.RefinementCtx,
  message: string
): void {
  context.addIssue({ code: z.ZodIssueCode.custom, message });
}

const BUDGET_MESSAGES: Readonly<Record<JsonValueBudgetViolation, string>> = {
  alias_or_cycle: "Studio JSON cannot contain object aliases or cycles",
  bytes: "Studio JSON exceeds its byte limit",
  depth: "Studio JSON exceeds its nesting limit",
  entries: "Studio JSON exceeds its entry limit",
  invalid_type: "Studio values must be JSON serializable",
  key_length: "Studio JSON contains an oversized property name",
  non_finite_number: "Studio JSON numbers must be finite",
  non_plain_object: "Studio JSON objects must be plain objects"
};

function validateBudget(
  value: unknown,
  limits: StudioJsonLimits,
  context: z.RefinementCtx
): void {
  const violation = jsonValueBudgetViolation(value, limits);
  if (violation !== undefined) {
    budgetIssue(context, BUDGET_MESSAGES[violation]);
  }
}

export function boundedStudioJsonValueSchema(
  limits: StudioJsonLimits
): z.ZodType<JsonValue, z.ZodTypeDef, unknown> {
  return z
    .unknown()
    .superRefine((value, context) => validateBudget(value, limits, context))
    .pipe(StudioJsonValueSchema);
}

export function boundedStudioJsonObjectSchema(
  limits: StudioJsonLimits
): z.ZodType<Record<string, JsonValue>, z.ZodTypeDef, unknown> {
  return boundedStudioJsonValueSchema(limits).pipe(
    z.record(StudioJsonValueSchema)
  );
}
