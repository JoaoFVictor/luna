import { z } from "zod";
import {
  StudioAdapterInputSchema,
  StudioAdapterPreviewEffectsSchema
} from "./input-routing.js";
import { StudioRunInvocationSchema } from "./run-launch.js";
import { StudioRunBoundedIdSchema } from "./run-launch-primitives.js";
import { WorkflowExecutionScopeSchema } from "../../core/workflow/execution-scope.js";

const StudioInvocationRunPlanInputSchema = z
  .object({
    kind: z.literal("invocation"),
    invocation: StudioRunInvocationSchema,
    execution_scope: WorkflowExecutionScopeSchema.default({ kind: "workflow" })
  })
  .strict();

const StudioAdapterRunPlanInputSchema = z
  .object({
    kind: z.literal("adapter"),
    adapter_id: StudioRunBoundedIdSchema,
    input: StudioAdapterInputSchema,
    acknowledged_effects: StudioAdapterPreviewEffectsSchema,
    execution_scope: WorkflowExecutionScopeSchema.default({ kind: "workflow" })
  })
  .strict();

export const StudioRunPlanInputSchema = z.discriminatedUnion("kind", [
  StudioInvocationRunPlanInputSchema,
  StudioAdapterRunPlanInputSchema
]);
export type StudioRunPlanInput = z.infer<typeof StudioRunPlanInputSchema>;
