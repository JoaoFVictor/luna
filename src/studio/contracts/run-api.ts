import { z } from "zod";
import {
  RunOpaqueIdSchema,
  RunTerminalStatusSchema
} from "./runs.js";
import { WorkflowIdSchema } from "../../core/router/invocation.js";
import { StudioRunPlanIdSchema } from "./run-launch-primitives.js";

const CursorSchema = z.string().min(1).max(4_096);
const PageLimitTextSchema = z
  .string()
  .regex(/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/);
const TimestampSchema = z.string().datetime({ offset: true });
const CommaSeparatedFilterSchema = z.string().min(1).max(2_048);

export const StudioRunParamsSchema = z
  .object({ runId: RunOpaqueIdSchema })
  .strict();
export type StudioRunParams = z.infer<typeof StudioRunParamsSchema>;

export const StudioRunListQuerySchema = z
  .object({
    workflow_id: WorkflowIdSchema.optional(),
    status: CommaSeparatedFilterSchema.optional(),
    source: z.string().trim().min(1).max(256).optional(),
    created_from: TimestampSchema.optional(),
    created_to: TimestampSchema.optional(),
    correlation_id: RunOpaqueIdSchema.optional(),
    job_id: RunOpaqueIdSchema.optional(),
    plan_id: StudioRunPlanIdSchema.optional(),
    direction: z.enum(["asc", "desc"]).optional(),
    limit: PageLimitTextSchema.optional(),
    cursor: CursorSchema.optional()
  })
  .strict();
export type StudioRunListQuery = z.infer<typeof StudioRunListQuerySchema>;

export const StudioRunTimelineQuerySchema = z
  .object({
    direction: z.enum(["asc", "desc"]).optional(),
    event_type: CommaSeparatedFilterSchema.optional(),
    limit: PageLimitTextSchema.optional(),
    cursor: CursorSchema.optional()
  })
  .strict();
export type StudioRunTimelineQuery = z.infer<
  typeof StudioRunTimelineQuerySchema
>;

export const StudioRunEventStreamCompleteSchema = z
  .object({
    run_id: RunOpaqueIdSchema,
    status: z.union([z.literal("rejected"), RunTerminalStatusSchema])
  })
  .strict();
export type StudioRunEventStreamComplete = z.infer<
  typeof StudioRunEventStreamCompleteSchema
>;
