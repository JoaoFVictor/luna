import { z } from "zod";
import { CAPABILITY_SIDE_EFFECT_CATEGORIES } from "../../core/capabilities/manifest.js";
import {
  StudioRunBoundedDescriptionSchema,
  StudioRunBoundedIdSchema
} from "./run-launch-primitives.js";

export const STUDIO_RUN_EFFECT_LIMITS = Object.freeze({
  maxPotentialEffects: 512,
  maxResolvedEffects: 512,
  maxEffectUncertainties: 128,
  maxWarnings: 128
} as const);

export const StudioRunEffectCategorySchema = z.enum(
  CAPABILITY_SIDE_EFFECT_CATEGORIES
);
export type StudioRunEffectCategory = z.infer<
  typeof StudioRunEffectCategorySchema
>;

export const StudioRunEffectRetrySemanticsSchema = z.enum([
  "replay_safe",
  "retry_requires_adoption",
  "retry_forbidden"
]);

export const StudioRunEffectIdempotencyScopeSchema = z.enum([
  "run",
  "node",
  "attempt",
  "external_resource"
]);

function requireWriteConfirmation(
  effect: {
    readonly category: StudioRunEffectCategory;
    readonly confirmation_required: boolean;
  },
  context: z.RefinementCtx
): void {
  if (
    (effect.category === "repository_write" ||
      effect.category === "external_write") &&
    !effect.confirmation_required
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["confirmation_required"],
      message: "Repository and external writes require confirmation"
    });
  }
}

export const StudioRunPotentialEffectSchema = z
  .object({
    effect_id: StudioRunBoundedIdSchema,
    category: StudioRunEffectCategorySchema,
    description: StudioRunBoundedDescriptionSchema,
    confirmation_required: z.boolean(),
    retry_semantics: StudioRunEffectRetrySemanticsSchema.optional(),
    idempotency_scope: StudioRunEffectIdempotencyScopeSchema.optional(),
    operation_id: StudioRunBoundedIdSchema.optional(),
    policy_id: StudioRunBoundedIdSchema.optional(),
    registration_id: StudioRunBoundedIdSchema.optional(),
    node_id: StudioRunBoundedIdSchema.optional(),
    provider_id: StudioRunBoundedIdSchema.optional()
  })
  .strict()
  .superRefine(requireWriteConfirmation);
export type StudioRunPotentialEffect = z.infer<
  typeof StudioRunPotentialEffectSchema
>;

export const StudioRunResolvedEffectSchema = z
  .object({
    effect_id: StudioRunBoundedIdSchema,
    potential_effect_id: StudioRunBoundedIdSchema,
    category: StudioRunEffectCategorySchema,
    description: StudioRunBoundedDescriptionSchema,
    confirmation_required: z.boolean(),
    retry_semantics: StudioRunEffectRetrySemanticsSchema.optional(),
    idempotency_scope: StudioRunEffectIdempotencyScopeSchema.optional(),
    resolution_source: z.enum(["invocation", "config", "preflight"]),
    operation_id: StudioRunBoundedIdSchema.optional(),
    policy_id: StudioRunBoundedIdSchema.optional(),
    registration_id: StudioRunBoundedIdSchema.optional(),
    node_id: StudioRunBoundedIdSchema.optional(),
    provider_id: StudioRunBoundedIdSchema.optional()
  })
  .strict()
  .superRefine(requireWriteConfirmation);
export type StudioRunResolvedEffect = z.infer<
  typeof StudioRunResolvedEffectSchema
>;

export const StudioRunEffectUncertaintySchema = z
  .object({
    uncertainty_id: StudioRunBoundedIdSchema,
    kind: z.enum([
      "dynamic_agent_tools",
      "runtime_branching",
      "provider_resolution",
      "configuration",
      "other"
    ]),
    description: StudioRunBoundedDescriptionSchema,
    may_include_unlisted_write: z.boolean(),
    node_id: StudioRunBoundedIdSchema.optional()
  })
  .strict();
export type StudioRunEffectUncertainty = z.infer<
  typeof StudioRunEffectUncertaintySchema
>;

export const StudioRunPlanWarningSchema = z
  .object({
    code: StudioRunBoundedIdSchema,
    message: StudioRunBoundedDescriptionSchema
  })
  .strict();
export type StudioRunPlanWarning = z.infer<
  typeof StudioRunPlanWarningSchema
>;

export type StudioRunEffectCollection = {
  readonly potential_effects: readonly StudioRunPotentialEffect[];
  readonly resolved_effects: readonly StudioRunResolvedEffect[];
  readonly effect_uncertainties: readonly StudioRunEffectUncertainty[];
  readonly warnings: readonly StudioRunPlanWarning[];
};

export function studioRunEffectsRequireConfirmation(
  value: StudioRunEffectCollection
): boolean {
  return value.potential_effects.some(
    (effect) => effect.confirmation_required
  ) || value.resolved_effects.some(
    (effect) => effect.confirmation_required
  ) || value.effect_uncertainties.some(
    (uncertainty) => uncertainty.may_include_unlisted_write
  );
}

function addUniqueIssues(
  values: readonly string[],
  path: string,
  context: z.RefinementCtx
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: `${path} must use unique ids`
    });
  }
}

export function validateStudioRunEffects(
  value: StudioRunEffectCollection,
  context: z.RefinementCtx
): void {
  addUniqueIssues(
    value.potential_effects.map((effect) => effect.effect_id),
    "potential_effects",
    context
  );
  addUniqueIssues(
    value.resolved_effects.map((effect) => effect.effect_id),
    "resolved_effects",
    context
  );
  addUniqueIssues(
    value.effect_uncertainties.map((item) => item.uncertainty_id),
    "effect_uncertainties",
    context
  );
  addUniqueIssues(
    value.warnings.map((warning) => warning.code),
    "warnings",
    context
  );

  const potentialIds = new Set(
    value.potential_effects.map((effect) => effect.effect_id)
  );
  for (const [index, effect] of value.resolved_effects.entries()) {
    if (!potentialIds.has(effect.potential_effect_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolved_effects", index, "potential_effect_id"],
        message: "Resolved effects must reference a potential effect"
      });
    }
  }
}
