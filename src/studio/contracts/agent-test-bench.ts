import { z } from "zod";
import {
  boundedStudioJsonObjectSchema,
  boundedStudioJsonValueSchema
} from "./bounded-json.js";
import { StudioDigestSchema } from "./digests.js";
import { StudioResourceRefSchema } from "./paths.js";

export const STUDIO_AGENT_TEST_LIMITS = Object.freeze({
  fixture: Object.freeze({
    maxBytes: 256 * 1024,
    maxDepth: 24,
    maxEntries: 4_096,
    maxKeyLength: 256
  }),
  context: Object.freeze({
    maxBytes: 256 * 1024,
    maxDepth: 24,
    maxEntries: 4_096,
    maxKeyLength: 256
  }),
  output: Object.freeze({
    maxBytes: 2 * 1024 * 1024,
    maxDepth: 32,
    maxEntries: 20_000,
    maxKeyLength: 512
  }),
  metadata: Object.freeze({
    maxBytes: 128 * 1024,
    maxDepth: 16,
    maxEntries: 2_048,
    maxKeyLength: 256
  }),
  maxModelProfiles: 128,
  maxCapabilities: 256,
  maxRequirements: 128
} as const);

const NonEmptyStringSchema = z.string().min(1);
const BoundedIdSchema = NonEmptyStringSchema.max(256);
const AgentIdSchema = StudioResourceRefSchema.shape.id;
const TimestampSchema = z.string().datetime({ offset: true });

export const StudioAgentTestPlanIdSchema = z
  .string()
  .min(25)
  .max(131)
  .regex(/^atp_[A-Za-z0-9_-]{21,127}$/);

export const StudioAgentTestConfirmationTokenSchema = z
  .string()
  .min(43)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

const StudioInstalledAgentTestTargetSchema = z
  .object({
    kind: z.literal("installed"),
    agent_id: AgentIdSchema,
    revision: StudioDigestSchema
  })
  .strict();

const StudioDraftAgentTestTargetSchema = z
  .object({
    kind: z.literal("draft"),
    draft_id: z.string().uuid(),
    etag: z.string().min(1).max(512)
  })
  .strict();

export const StudioAgentTestTargetSchema = z.discriminatedUnion("kind", [
  StudioInstalledAgentTestTargetSchema,
  StudioDraftAgentTestTargetSchema
]);
export type StudioAgentTestTarget = z.infer<
  typeof StudioAgentTestTargetSchema
>;

export const StudioAgentTestExplicitContextSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("none") }).strict(),
    z
      .object({
        kind: z.literal("json"),
        value: boundedStudioJsonObjectSchema(
          STUDIO_AGENT_TEST_LIMITS.context
        )
      })
      .strict()
  ]
);
export type StudioAgentTestExplicitContext = z.infer<
  typeof StudioAgentTestExplicitContextSchema
>;

export const StudioAgentTestPlanRequestSchema = z
  .object({
    target: StudioAgentTestTargetSchema,
    fixture: boundedStudioJsonObjectSchema(STUDIO_AGENT_TEST_LIMITS.fixture),
    context: StudioAgentTestExplicitContextSchema,
    model_profile_id: BoundedIdSchema.optional()
  })
  .strict();
export type StudioAgentTestPlanRequest = z.infer<
  typeof StudioAgentTestPlanRequestSchema
>;

export const StudioAgentTestLaunchContextSchema = z
  .object({
    actor_binding: z.string().min(16).max(512),
    request_id: z.string().min(8).max(256)
  })
  .strict();
export type StudioAgentTestLaunchContext = z.infer<
  typeof StudioAgentTestLaunchContextSchema
>;

export const StudioAgentTestModelProfileSchema = z
  .object({
    id: BoundedIdSchema,
    provider: NonEmptyStringSchema.max(256).optional(),
    model: NonEmptyStringSchema.max(512),
    reasoning_effort: z.enum(["low", "medium", "high", "xhigh"]),
    transport: z.enum(["auto", "sse", "websocket"]).optional()
  })
  .strict();
export type StudioAgentTestModelProfile = z.infer<
  typeof StudioAgentTestModelProfileSchema
>;

const StudioAgentTestToolSafetySchema = z
  .object({
    local_writes: z.boolean(),
    network: z.boolean(),
    external_side_effects: z.boolean()
  })
  .strict();

export const StudioAgentTestToolPreviewSchema = z
  .object({
    id: BoundedIdSchema,
    protocol: z.enum(["local", "mcp"]),
    execution: z.enum([
      "excluded_no_isolation",
      "excluded_runtime_unsupported"
    ]),
    reason: NonEmptyStringSchema.max(512),
    runtime_requirements: z
      .array(BoundedIdSchema)
      .max(STUDIO_AGENT_TEST_LIMITS.maxRequirements),
    safety: StudioAgentTestToolSafetySchema.optional()
  })
  .strict();
export type StudioAgentTestToolPreview = z.infer<
  typeof StudioAgentTestToolPreviewSchema
>;

export const StudioAgentTestMcpPreviewSchema = z
  .object({
    id: BoundedIdSchema,
    configured: z.literal(true),
    runtime_supported: z.boolean(),
    execution: z.literal("excluded_from_smoke"),
    reason: NonEmptyStringSchema.max(512)
  })
  .strict();
export type StudioAgentTestMcpPreview = z.infer<
  typeof StudioAgentTestMcpPreviewSchema
>;

export const StudioAgentTestSubagentPreviewSchema = z
  .object({
    id: AgentIdSchema,
    declared_mode: z.enum(["read_only", "trusted_local_write"]),
    policy_mode: z.enum(["read_only", "trusted_local_write"]).optional(),
    execution: z.literal("excluded_from_smoke"),
    reason: NonEmptyStringSchema.max(512)
  })
  .strict();
export type StudioAgentTestSubagentPreview = z.infer<
  typeof StudioAgentTestSubagentPreviewSchema
>;

export const StudioAgentTestRequirementPreviewSchema = z
  .object({
    id: BoundedIdSchema,
    sources: z
      .array(z.enum(["agent", "local_tool", "mcp"]))
      .min(1)
      .max(3),
    runtime_supported: z.boolean(),
    required_for_smoke: z.boolean()
  })
  .strict();
export type StudioAgentTestRequirementPreview = z.infer<
  typeof StudioAgentTestRequirementPreviewSchema
>;

export const StudioAgentTestRuntimePreviewSchema = z
  .object({
    id: BoundedIdSchema,
    display_name: NonEmptyStringSchema.max(256),
    supported_tool_protocols: z.array(z.enum(["local", "mcp"])).max(2),
    supported_runtime_requirements: z
      .array(BoundedIdSchema)
      .max(STUDIO_AGENT_TEST_LIMITS.maxRequirements),
    configuration_hash: StudioDigestSchema
  })
  .strict();
export type StudioAgentTestRuntimePreview = z.infer<
  typeof StudioAgentTestRuntimePreviewSchema
>;

export const StudioAgentTestBlockerSchema = z
  .object({
    code: z.enum([
      "trusted_write_requires_isolation",
      "runtime_requirement_unsupported",
      "runtime_validation_failed"
    ]),
    message: NonEmptyStringSchema.max(512)
  })
  .strict();
export type StudioAgentTestBlocker = z.infer<
  typeof StudioAgentTestBlockerSchema
>;

function sameAgentTestBlockers(
  left: readonly StudioAgentTestBlocker[],
  right: readonly StudioAgentTestBlocker[]
): boolean {
  return left.length === right.length && left.every((blocker, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      blocker.code === candidate.code &&
      blocker.message === candidate.message;
  });
}

export const StudioAgentTestScopeSchema = z
  .object({
    real_model_call: z.literal(true),
    local_tools_executed: z.literal(false),
    mcp_executed: z.literal(false),
    subagents_executed: z.literal(false),
    workflow_context_included: z.literal(false),
    repository_context_included: z.literal(false),
    agent_context_files_included: z.literal(false),
    workflow_equivalent: z.literal(false),
    statement: NonEmptyStringSchema.max(512)
  })
  .strict();
export type StudioAgentTestScope = z.infer<
  typeof StudioAgentTestScopeSchema
>;

const StudioInstalledAgentTestSnapshotSchema = z
  .object({
    kind: z.literal("installed"),
    agent_id: AgentIdSchema,
    agent_revision: StudioDigestSchema,
    requested_revision: StudioDigestSchema
  })
  .strict();

const StudioDraftAgentTestSnapshotSchema = z
  .object({
    kind: z.literal("draft"),
    agent_id: AgentIdSchema,
    agent_revision: StudioDigestSchema,
    draft_id: z.string().uuid(),
    etag: z.string().min(1).max(512),
    record_revision: z.number().int().safe().positive(),
    content_revision: z.number().int().safe().positive()
  })
  .strict();

export const StudioAgentTestTargetSnapshotSchema = z.discriminatedUnion(
  "kind",
  [
    StudioInstalledAgentTestSnapshotSchema,
    StudioDraftAgentTestSnapshotSchema
  ]
);
export type StudioAgentTestTargetSnapshot = z.infer<
  typeof StudioAgentTestTargetSnapshotSchema
>;

export const StudioAgentTestResolutionSchema = z
  .object({
    target: StudioAgentTestTargetSnapshotSchema,
    agent_mode: z.enum(["read_only", "trusted_local_write"]),
    default_model_profile_id: BoundedIdSchema,
    selected_model_profile: StudioAgentTestModelProfileSchema,
    available_model_profiles: z
      .array(StudioAgentTestModelProfileSchema)
      .min(1)
      .max(STUDIO_AGENT_TEST_LIMITS.maxModelProfiles),
    runtime: StudioAgentTestRuntimePreviewSchema,
    tools: z
      .array(StudioAgentTestToolPreviewSchema)
      .max(STUDIO_AGENT_TEST_LIMITS.maxCapabilities),
    mcp_servers: z
      .array(StudioAgentTestMcpPreviewSchema)
      .max(STUDIO_AGENT_TEST_LIMITS.maxCapabilities),
    subagents: z
      .array(StudioAgentTestSubagentPreviewSchema)
      .max(STUDIO_AGENT_TEST_LIMITS.maxCapabilities),
    declared_skills: z
      .array(NonEmptyStringSchema.max(1_024))
      .max(STUDIO_AGENT_TEST_LIMITS.maxCapabilities),
    declared_agent_context_files: z
      .array(NonEmptyStringSchema.max(1_024))
      .max(STUDIO_AGENT_TEST_LIMITS.maxCapabilities),
    runtime_requirements: z
      .array(StudioAgentTestRequirementPreviewSchema)
      .max(STUDIO_AGENT_TEST_LIMITS.maxRequirements),
    blockers: z.array(StudioAgentTestBlockerSchema).max(32),
    catalog_fingerprint: StudioDigestSchema,
    output_schema_hash: StudioDigestSchema,
    instructions_hash: StudioDigestSchema,
    scope: StudioAgentTestScopeSchema
  })
  .strict()
  .superRefine((resolution, context) => {
    if (
      !resolution.available_model_profiles.some(
        (profile) => profile.id === resolution.selected_model_profile.id
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selected_model_profile", "id"],
        message: "Selected model profile must be loaded and available"
      });
    }
  });
export type StudioAgentTestResolution = z.infer<
  typeof StudioAgentTestResolutionSchema
>;

const StudioAgentTestExecutionUnavailableSchema = z
  .object({
    available: z.literal(false),
    blockers: z.array(StudioAgentTestBlockerSchema).min(1).max(32)
  })
  .strict();

const StudioAgentTestExecutionAvailableSchema = z
  .object({
    available: z.literal(true),
    confirmation_required: z.literal(true),
    confirmation_token: StudioAgentTestConfirmationTokenSchema
  })
  .strict();

export const StudioAgentTestPlanSchema = z
  .object({
    plan_id: StudioAgentTestPlanIdSchema,
    created_at: TimestampSchema,
    expires_at: TimestampSchema,
    snapshot_hash: StudioDigestSchema,
    fixture_hash: StudioDigestSchema,
    context_hash: StudioDigestSchema,
    resolution: StudioAgentTestResolutionSchema,
    execution: z.discriminatedUnion("available", [
      StudioAgentTestExecutionUnavailableSchema,
      StudioAgentTestExecutionAvailableSchema
    ])
  })
  .strict()
  .superRefine((plan, context) => {
    if (Date.parse(plan.expires_at) <= Date.parse(plan.created_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expires_at"],
        message: "Agent test plan expiry must follow creation"
      });
    }
    if (
      plan.execution.available === false &&
      !sameAgentTestBlockers(
        plan.execution.blockers,
        plan.resolution.blockers
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["execution", "blockers"],
        message: "Unavailable execution must project all resolution blockers"
      });
    }
  });
export type StudioAgentTestPlan = z.infer<typeof StudioAgentTestPlanSchema>;

export const StudioAgentTestExecuteRequestSchema = z
  .object({
    confirmation_token: StudioAgentTestConfirmationTokenSchema,
    confirmation: z
      .object({
        kind: z.literal("local_explicit"),
        real_model_call_confirmed: z.literal(true),
        isolated_smoke_scope_confirmed: z.literal(true)
      })
      .strict()
  })
  .strict();
export type StudioAgentTestExecuteRequest = z.infer<
  typeof StudioAgentTestExecuteRequestSchema
>;

const OptionalUsageNumberSchema = z.number().finite().nonnegative().optional();

export const StudioAgentTestUsageSchema = z
  .object({
    input_tokens: OptionalUsageNumberSchema,
    output_tokens: OptionalUsageNumberSchema,
    total_tokens: OptionalUsageNumberSchema,
    cache_read_tokens: OptionalUsageNumberSchema,
    cache_write_tokens: OptionalUsageNumberSchema,
    cost: z
      .object({
        input: OptionalUsageNumberSchema,
        output: OptionalUsageNumberSchema,
        cache_read: OptionalUsageNumberSchema,
        cache_write: OptionalUsageNumberSchema,
        total: OptionalUsageNumberSchema,
        unit: NonEmptyStringSchema.max(128).optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const StudioAgentTestResultSchema = z
  .object({
    plan_id: StudioAgentTestPlanIdSchema,
    snapshot_hash: StudioDigestSchema,
    completed_at: TimestampSchema,
    output: boundedStudioJsonValueSchema(STUDIO_AGENT_TEST_LIMITS.output),
    output_schema_validated: z.literal(true),
    usage: StudioAgentTestUsageSchema.optional(),
    runtime_metadata: boundedStudioJsonObjectSchema(
      STUDIO_AGENT_TEST_LIMITS.metadata
    ).optional(),
    scope: StudioAgentTestScopeSchema
  })
  .strict();
export type StudioAgentTestResult = z.infer<
  typeof StudioAgentTestResultSchema
>;
