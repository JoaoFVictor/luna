import { z } from "zod";
import { assertJsonValue, type JsonValue } from "../../core/json/value.js";
import type { JsonObject } from "../../core/runtime/backends/contracts.js";

const NonEmptyStringSchema = z.string().min(1);

const JsonObjectSchema = z
  .record(z.unknown())
  .superRefine((value, context) => {
    try {
      assertJsonValue(value);
    } catch (cause) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: cause instanceof Error ? cause.message : "value must be JSON"
      });
    }
  })
  .transform((value) => value as { [key: string]: JsonValue });

export const RuntimeModeSchema = z.enum(["test", "production"]);
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

export const RuntimeSelectionSchema = z
  .object({
    id: NonEmptyStringSchema,
    options: JsonObjectSchema.default({})
  })
  .strict();
export type RuntimeSelection = z.infer<typeof RuntimeSelectionSchema>;

export const RuntimeBackendsConfigSchema = z
  .object({
    artifacts: RuntimeSelectionSchema,
    events: RuntimeSelectionSchema,
    interrupts: RuntimeSelectionSchema,
    checkpoints: RuntimeSelectionSchema,
    runtime_logs: RuntimeSelectionSchema
  })
  .strict();
export type RuntimeBackendsConfig = z.infer<typeof RuntimeBackendsConfigSchema>;

export const RuntimeCompositionConfigSchema = z
  .object({
    mode: RuntimeModeSchema.default("production"),
    backends: RuntimeBackendsConfigSchema,
    agent_runtime: RuntimeSelectionSchema,
    interrupt_authorization: RuntimeSelectionSchema,
    capability_ports: z.record(RuntimeSelectionSchema).optional()
  })
  .strict();
export type RuntimeCompositionConfig = z.infer<
  typeof RuntimeCompositionConfigSchema
>;

export function parseRuntimeCompositionConfig(
  value: unknown
): RuntimeCompositionConfig {
  return RuntimeCompositionConfigSchema.parse(value);
}

export function selectionOptions(selection: RuntimeSelection): JsonObject {
  return selection.options as JsonObject;
}
