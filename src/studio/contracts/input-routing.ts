import { z } from "zod";
import {
  InvocationSchema,
  RouteTargetSchema
} from "../../core/router/invocation.js";
import {
  ROUTER_DEFINITION_MAX_RULES,
  ROUTER_RULE_ID_MAX_LENGTH
} from "../../core/router/router-definition.js";
import { StudioJsonValueSchema } from "./json.js";

const NonEmptyStringSchema = z.string().min(1);
const StudioRouterRuleIdSchema = NonEmptyStringSchema.max(
  ROUTER_RULE_ID_MAX_LENGTH
);

export const STUDIO_ADAPTER_INPUT_MAX_LENGTH = 64 * 1_024;
export const STUDIO_INVOCATION_PAYLOAD_MAX_BYTES = 512 * 1_024;
export const STUDIO_INVOCATION_PAYLOAD_MAX_ENTRIES = 1_024;
export const STUDIO_ROUTING_DIAGNOSTIC_MESSAGE_MAX_LENGTH = 2_000;
export const STUDIO_ROUTING_DIAGNOSTIC_PATH_MAX_LENGTH = 1_024;
const UTF8_ENCODER = new TextEncoder();

const StudioInvocationPayloadBudgetSchema = z
  .unknown()
  .superRefine((payload, context) => {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Studio invocation payload must be JSON serializable"
      });
      return;
    }
    if (
      serialized.length > STUDIO_INVOCATION_PAYLOAD_MAX_BYTES ||
      UTF8_ENCODER.encode(serialized).byteLength >
        STUDIO_INVOCATION_PAYLOAD_MAX_BYTES
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Studio invocation payload exceeds its byte limit"
      });
    }
  });

const StudioInvocationPayloadSchema = StudioInvocationPayloadBudgetSchema.pipe(
  z
    .record(NonEmptyStringSchema.max(1_024), StudioJsonValueSchema)
    .superRefine((payload, context) => {
      if (Object.keys(payload).length > STUDIO_INVOCATION_PAYLOAD_MAX_ENTRIES) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Studio invocation payload has too many entries"
        });
      }
    })
);

export const StudioInvocationSchema = InvocationSchema.extend({
  payload: StudioInvocationPayloadSchema.optional()
});
export type StudioInvocation = z.infer<typeof StudioInvocationSchema>;

export const StudioPublicInvocationSchema = InvocationSchema.omit({
  references: true,
  payload: true
});
export type StudioPublicInvocation = z.infer<
  typeof StudioPublicInvocationSchema
>;

export const StudioAdapterInputSchema = z
  .object({
    kind: z.literal("cli"),
    value: NonEmptyStringSchema.max(STUDIO_ADAPTER_INPUT_MAX_LENGTH)
  })
  .strict();
export type StudioAdapterInput = z.infer<typeof StudioAdapterInputSchema>;

export const StudioAdapterPreviewEffectSchema = z.enum([
  "project_read",
  "configuration_read",
  "credential_read",
  "network_read",
  "process_execution"
]);
export type StudioAdapterPreviewEffect = z.infer<
  typeof StudioAdapterPreviewEffectSchema
>;

export const StudioAdapterPreviewEffectsSchema = z
  .array(StudioAdapterPreviewEffectSchema)
  .max(StudioAdapterPreviewEffectSchema.options.length)
  .superRefine((effects, context) => {
    if (new Set(effects).size !== effects.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Adapter preview effects must be unique"
      });
    }
  });

export const StudioAdapterPreviewTimeoutMsSchema = z
  .number()
  .int()
  .safe()
  .positive()
  .max(2_147_483_647);

const StudioAdapterPreviewAvailabilitySchema = z.discriminatedUnion(
  "enabled",
  [
    z.object({ enabled: z.literal(false) }).strict(),
    z
      .object({
        enabled: z.literal(true),
        effects: StudioAdapterPreviewEffectsSchema,
        timeout_ms: StudioAdapterPreviewTimeoutMsSchema
      })
      .strict()
  ]
);

export const StudioInputAdapterSummarySchema = z
  .object({
    id: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    source: NonEmptyStringSchema,
    input_contract: z
      .object({
        kind: z.literal("cli"),
        value_type: z.literal("string")
      })
      .strict(),
    preview: StudioAdapterPreviewAvailabilitySchema
  })
  .strict();
export type StudioInputAdapterSummary = z.infer<
  typeof StudioInputAdapterSummarySchema
>;

export const StudioInputAdapterCatalogSchema = z
  .object({
    adapters: z.array(StudioInputAdapterSummarySchema)
  })
  .strict();
export type StudioInputAdapterCatalog = z.infer<
  typeof StudioInputAdapterCatalogSchema
>;

export const StudioAdapterPreviewRequestSchema = z
  .object({
    adapter_id: NonEmptyStringSchema,
    input: StudioAdapterInputSchema,
    acknowledged_effects: StudioAdapterPreviewEffectsSchema
  })
  .strict();
export type StudioAdapterPreviewRequest = z.infer<
  typeof StudioAdapterPreviewRequestSchema
>;

export const StudioAdapterPreviewSchema = z
  .object({
    adapter_id: NonEmptyStringSchema,
    effects: StudioAdapterPreviewEffectsSchema,
    invocation: StudioPublicInvocationSchema,
    redacted_fields: z.array(z.enum(["references", "payload"]))
  })
  .strict();
export type StudioAdapterPreview = z.infer<
  typeof StudioAdapterPreviewSchema
>;

export const StudioRoutingDiagnosticSchema = z
  .object({
    severity: z.enum(["warning", "error"]),
    code: z.enum([
      "router_expression_failed",
      "router_invalid_target",
      "router_no_match"
    ]),
    message: NonEmptyStringSchema.max(
      STUDIO_ROUTING_DIAGNOSTIC_MESSAGE_MAX_LENGTH
    ),
    path: NonEmptyStringSchema.max(
      STUDIO_ROUTING_DIAGNOSTIC_PATH_MAX_LENGTH
    ).optional(),
    rule_id: StudioRouterRuleIdSchema.optional(),
    rule_index: z.number().int().safe().nonnegative().optional()
  })
  .strict();
export type StudioRoutingDiagnostic = z.infer<
  typeof StudioRoutingDiagnosticSchema
>;

const StudioRoutingRuleEvaluationCommonShape = {
  rule_id: StudioRouterRuleIdSchema,
  rule_index: z.number().int().safe().nonnegative(),
  expression_path: NonEmptyStringSchema.max(
    STUDIO_ROUTING_DIAGNOSTIC_PATH_MAX_LENGTH
  )
} as const;

export const StudioRoutingRuleEvaluationSchema = z.union([
  z
    .object({
      ...StudioRoutingRuleEvaluationCommonShape,
      outcome: z.literal("boolean"),
      result: z.boolean()
    })
    .strict(),
  z
    .object({
      ...StudioRoutingRuleEvaluationCommonShape,
      outcome: z.literal("error"),
      diagnostic: StudioRoutingDiagnosticSchema
    })
    .strict()
]);
export type StudioRoutingRuleEvaluation = z.infer<
  typeof StudioRoutingRuleEvaluationSchema
>;

export const StudioRoutingSimulationRequestSchema = z
  .object({
    invocation: StudioInvocationSchema
  })
  .strict();
export type StudioRoutingSimulationRequest = z.infer<
  typeof StudioRoutingSimulationRequestSchema
>;

export const StudioRoutingSimulationSchema = z
  .object({
    status: z.enum(["matched", "no_match", "error"]),
    evaluations: z
      .array(StudioRoutingRuleEvaluationSchema)
      .max(ROUTER_DEFINITION_MAX_RULES),
    matched_rule: z
      .object({
        rule_id: StudioRouterRuleIdSchema,
        rule_index: z.number().int().safe().nonnegative()
      })
      .strict()
      .nullable(),
    target: RouteTargetSchema.nullable(),
    diagnostics: z
      .array(StudioRoutingDiagnosticSchema)
      .max(ROUTER_DEFINITION_MAX_RULES)
  })
  .strict();
export type StudioRoutingSimulation = z.infer<
  typeof StudioRoutingSimulationSchema
>;
