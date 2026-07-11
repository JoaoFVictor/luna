import { z } from "zod";
import { RunOpaqueIdSchema } from "./runs.js";

const TimestampSchema = z.string().datetime({ offset: true });
const PageLimitSchema = z.number().int().safe().min(1).max(200);

export const StudioRunLogLevelSchema = z.enum([
  "debug",
  "info",
  "warn",
  "error"
]);
export type StudioRunLogLevel = z.infer<typeof StudioRunLogLevelSchema>;

export const RunLogCursorSchema = z
  .string()
  .min(20)
  .max(4_096)
  .regex(/^lc2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "Invalid log cursor");

export const RunLogListQuerySchema = z
  .object({
    run_id: RunOpaqueIdSchema,
    levels: z.array(StudioRunLogLevelSchema).max(4).default([]),
    node_id: z.string().trim().min(1).max(256).optional(),
    limit: PageLimitSchema.default(50),
    cursor: RunLogCursorSchema.optional()
  })
  .strict()
  .superRefine((query, context) => {
    if (new Set(query.levels).size !== query.levels.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["levels"],
        message: "Log level filters must be unique"
      });
    }
  });
export type RunLogListQuery = z.input<typeof RunLogListQuerySchema>;

export const StudioRunLogEntrySchema = z
  .object({
    sequence: z.number().int().safe().positive(),
    timestamp: TimestampSchema,
    message: z.string().max(65_536),
    level: StudioRunLogLevelSchema.optional(),
    node_id: z.string().min(1).max(256).optional(),
    redaction: z.literal("best_effort")
  })
  .strict();
export type StudioRunLogEntry = z.infer<typeof StudioRunLogEntrySchema>;

export const RunLogPageSchema = z
  .object({
    run_id: RunOpaqueIdSchema,
    items: z.array(StudioRunLogEntrySchema).max(200),
    next_cursor: RunLogCursorSchema.nullable(),
    as_of: TimestampSchema,
    snapshot_bytes: z.number().int().safe().nonnegative(),
    scanned_bytes: z.number().int().safe().nonnegative(),
    redaction: z.literal("best_effort")
  })
  .strict();
export type RunLogPage = z.infer<typeof RunLogPageSchema>;
