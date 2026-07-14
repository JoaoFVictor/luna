import { z } from "zod";
import { boundedStudioJsonValueSchema } from "./bounded-json.js";
import { RunOpaqueIdSchema } from "./runs.js";
import { ArtifactSummarySchema } from "./artifacts.js";

const InterruptJsonSchema = boundedStudioJsonValueSchema({
  maxBytes: 262_144,
  maxDepth: 24,
  maxEntries: 5_000,
  maxKeyLength: 256
});

export const StudioRunInterruptStatusSchema = z.enum([
  "pending",
  "resuming",
  "resolved",
  "cancelled"
]);

export const StudioRunInterruptReviewTargetSchema = z.object({
  id: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(256)
}).strict();

export const StudioRunInterruptReviewSchema = z.object({
  targets: z.array(StudioRunInterruptReviewTargetSchema).min(1).max(32),
  expected_artifact_count: z.number().int().safe().nonnegative().max(128),
  approval: z.object({
    allowed: z.boolean(),
    reason: z.string().min(1).max(2048)
  }).strict().optional()
}).strict();

export const StudioRunInterruptMaterialsStatusSchema = z.enum([
  "ready",
  "pending",
  "unavailable"
]);

const StudioRunInterruptCommentSchema = z.string().trim().min(1).max(8_192);
const StudioRunInterruptTargetsSchema = z
  .array(z.string().trim().min(1).max(128))
  .min(1)
  .max(32)
  .refine((targets) => new Set(targets).size === targets.length, {
    message: "Review targets must be unique"
  });

export const StudioRunInterruptDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    comment: StudioRunInterruptCommentSchema.optional()
  }).strict(),
  z.object({
    action: z.literal("reject"),
    comment: StudioRunInterruptCommentSchema.optional()
  }).strict(),
  z.object({
    action: z.literal("request_changes"),
    comment: StudioRunInterruptCommentSchema,
    targets: StudioRunInterruptTargetsSchema
  }).strict()
]);

export const StudioRunInterruptItemSchema = z.object({
  interrupt_id: RunOpaqueIdSchema,
  checkpoint_id: RunOpaqueIdSchema,
  node_id: z.string().trim().min(1).max(256),
  kind: z.string().trim().min(1).max(256),
  status: StudioRunInterruptStatusSchema,
  prompt: z.string().max(32_768),
  decisions: z.array(InterruptJsonSchema).max(256),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  decision: StudioRunInterruptDecisionSchema.optional(),
  review: StudioRunInterruptReviewSchema.optional(),
  materials_status: StudioRunInterruptMaterialsStatusSchema,
  artifacts: z.array(ArtifactSummarySchema).max(128)
}).strict();

export const StudioRunInterruptCursorSchema = z.string()
  .min(1)
  .max(4_096)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid interrupt cursor");

export const StudioRunInterruptListQuerySchema = z.object({
  limit: z.number().int().safe().min(1).max(200).default(50),
  cursor: StudioRunInterruptCursorSchema.optional()
}).strict();

export const StudioRunInterruptListSchema = z.object({
  run_id: RunOpaqueIdSchema,
  items: z.array(StudioRunInterruptItemSchema).max(200),
  next_cursor: StudioRunInterruptCursorSchema.nullable()
}).strict();

export const StudioRunInterruptResumeRequestSchema = StudioRunInterruptDecisionSchema;

export const StudioRunInterruptResumeReceiptSchema = z.object({
  accepted: z.literal(true),
  run_id: RunOpaqueIdSchema,
  interrupt_id: RunOpaqueIdSchema,
  resume_status: z.enum([
    "resuming",
    "waiting_for_input",
    "succeeded",
    "failed"
  ]),
  already_resumed: z.boolean()
}).strict();

export type StudioRunInterruptList = z.infer<
  typeof StudioRunInterruptListSchema
>;
export type StudioRunInterruptListQuery = z.input<
  typeof StudioRunInterruptListQuerySchema
>;
export type StudioRunInterruptResumeRequest = z.infer<
  typeof StudioRunInterruptResumeRequestSchema
>;
export type StudioRunInterruptResumeReceipt = z.infer<
  typeof StudioRunInterruptResumeReceiptSchema
>;
