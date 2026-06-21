import { z } from "zod";
import type { ImplementationConfig } from "./write-mode/types.js";

const NonEmptyStringSchema = z.string().min(1);
const AbsoluteUrlSchema = z.string().url();

export const RepositoryRefSchema = z
  .object({
    owner: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    full_name: NonEmptyStringSchema
  })
  .strict();
export type RepositoryRef = z.infer<typeof RepositoryRefSchema>;

export const HeadRepositoryRefSchema = RepositoryRefSchema.extend({
  fork: z.boolean().optional()
}).strict();
export type HeadRepositoryRef = z.infer<typeof HeadRepositoryRefSchema>;

export const RouteTargetSchema = z
  .object({
    type: z.literal("workflow"),
    id: NonEmptyStringSchema
  })
  .strict();
export type RouteTarget = z.infer<typeof RouteTargetSchema>;

export const InvocationRepositorySchema = z
  .object({
    provider: NonEmptyStringSchema,
    owner: NonEmptyStringSchema,
    name: NonEmptyStringSchema
  })
  .strict();
export type InvocationRepository = z.infer<typeof InvocationRepositorySchema>;

export const InvocationSubjectSchema = z
  .object({
    type: NonEmptyStringSchema,
    id: NonEmptyStringSchema,
    url: AbsoluteUrlSchema.optional(),
    title: NonEmptyStringSchema.optional()
  })
  .strict();
export type InvocationSubject = z.infer<typeof InvocationSubjectSchema>;

export const InvocationActorSchema = z
  .object({
    id: NonEmptyStringSchema.optional(),
    display_name: NonEmptyStringSchema.optional()
  })
  .strict();
export type InvocationActor = z.infer<typeof InvocationActorSchema>;

export const NormalizedInvocationSchema = z
  .object({
    version: z.literal("2026-06"),
    source: NonEmptyStringSchema,
    event: NonEmptyStringSchema,
    action: NonEmptyStringSchema.optional(),
    target: RouteTargetSchema.optional(),
    repository: InvocationRepositorySchema.optional(),
    subject: InvocationSubjectSchema.optional(),
    actor: InvocationActorSchema.optional(),
    references: z.record(NonEmptyStringSchema, NonEmptyStringSchema).optional(),
    payload: z.record(NonEmptyStringSchema, z.unknown()).optional()
  })
  .strict();
export type NormalizedInvocation = z.infer<typeof NormalizedInvocationSchema>;

export const InvocationSchema = NormalizedInvocationSchema;
export type Invocation = NormalizedInvocation;

export const RepositoryConfigSchema = z
  .object({
    id: NonEmptyStringSchema,
    provider: NonEmptyStringSchema,
    owner: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
    remote: NonEmptyStringSchema,
    expected_remote_urls: z.array(NonEmptyStringSchema).optional()
  })
  .strict();
export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;

export const RepositoriesConfigSchema = z
  .object({
    repositories: z.array(RepositoryConfigSchema)
  })
  .strict();
export type RepositoriesConfig = z.infer<typeof RepositoriesConfigSchema>;

export const ModelProfileSchema = z
  .object({
    model: NonEmptyStringSchema,
    reasoning_effort: z.enum(["low", "medium", "high"])
  })
  .strict();
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const ModelsConfigSchema = z
  .object({
    model_profiles: z.record(NonEmptyStringSchema, ModelProfileSchema)
  })
  .strict();
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

export const RouteWhenSchema = z
  .object({
    has_target: z.boolean().optional(),
    source: NonEmptyStringSchema.optional(),
    event: NonEmptyStringSchema.optional(),
    event_in: z.array(NonEmptyStringSchema).optional(),
    action: NonEmptyStringSchema.optional(),
    action_in: z.array(NonEmptyStringSchema).optional()
  })
  .strict()
  .superRefine((when, context) => {
    if (when.event !== undefined && when.event_in !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "event and event_in cannot be used together",
        path: ["event"]
      });
    }

    if (when.action !== undefined && when.action_in !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "action and action_in cannot be used together",
        path: ["action"]
      });
    }
  });
export type RouteWhen = z.infer<typeof RouteWhenSchema>;

export const RouteSchema = z
  .object({
    name: NonEmptyStringSchema,
    when: RouteWhenSchema,
    use_target_from_input: z.boolean().optional(),
    target: RouteTargetSchema.optional()
  })
  .strict();
export type Route = z.infer<typeof RouteSchema>;

export const RoutingConfigSchema = z
  .object({
    routes: z.array(RouteSchema)
  })
  .strict();
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

export const WorkspaceConfigSchema = z
  .object({
    strategy: z.literal("git_worktree"),
    root: NonEmptyStringSchema,
    preserve_on_success: z.boolean(),
    preserve_on_failure: z.boolean()
  })
  .strict();
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export const ArtifactsConfigSchema = z
  .object({
    root: NonEmptyStringSchema
  })
  .strict();
export type ArtifactsConfig = z.infer<typeof ArtifactsConfigSchema>;

export const LockConfigSchema = z
  .object({
    root: NonEmptyStringSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
    stale_after_ms: z.number().int().positive().optional()
  })
  .strict()
  .superRefine((locks, context) => {
    if (locks.stale_after_ms !== undefined) {
      const heartbeat = Math.min(30000, Math.floor(locks.stale_after_ms / 3));
      if (heartbeat < 1000) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "locks.stale_after_ms must allow heartbeat >= 1000ms",
          path: ["stale_after_ms"]
        });
      }
    }
  });
export type LockConfig = z.infer<typeof LockConfigSchema>;

export const AppConfigSchema = z
  .object({
    workspace: WorkspaceConfigSchema,
    artifacts: ArtifactsConfigSchema,
    locks: LockConfigSchema.optional()
  })
  .strict();
export type AppConfig = z.infer<typeof AppConfigSchema>;

export const ValidationCommandSchema = z
  .object({
    cmd: NonEmptyStringSchema,
    args: z.array(z.string()).optional(),
    timeout_ms: z.number().int().positive().optional()
  })
  .strict();
export type ValidationCommand = z.infer<typeof ValidationCommandSchema>;

export const ValidationCommandResultSchema = z
  .object({
    cmd: NonEmptyStringSchema,
    args: z.array(z.string()).optional(),
    exit_code: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    stdout_truncated: z.boolean(),
    stderr_truncated: z.boolean(),
    duration_ms: z.number().int().nonnegative(),
    timed_out: z.boolean()
  })
  .strict();
export type ValidationCommandResult = z.infer<
  typeof ValidationCommandResultSchema
>;

export const ValidationResultSchema = z
  .object({
    passed: z.boolean(),
    commands: z.array(ValidationCommandResultSchema).optional()
  })
  .strict();
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const AgentLoopAttemptSchema = z
  .object({
    attempt: z.number().int().positive(),
    phase: z.enum(["initial", "repair"]),
    agent_output: z.unknown().optional(),
    agent_error: z
      .object({
        message: NonEmptyStringSchema,
        code: NonEmptyStringSchema.optional()
      })
      .strict()
      .optional(),
    validation: ValidationResultSchema.optional(),
    diff_summary: z.unknown().optional(),
    duration_ms: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional()
  })
  .strict();
export type AgentLoopAttempt = z.infer<typeof AgentLoopAttemptSchema>;

export const AgentLoopResultSchema = z
  .object({
    status: z.enum(["passed", "failed"]),
    attempts_exhausted: z.boolean(),
    attempts: z.array(AgentLoopAttemptSchema),
    validation: ValidationResultSchema,
    final_validation: ValidationResultSchema,
    result: z
      .object({
        status: NonEmptyStringSchema
      })
      .passthrough()
  })
  .strict();
export type AgentLoopResult = z.infer<typeof AgentLoopResultSchema>;

export type RuntimeConfigState = {
  implementation?: ImplementationConfig["implementation"];
};

export const RunIdentitySchema = z
  .object({
    run_id: NonEmptyStringSchema,
    flue_run_id: NonEmptyStringSchema.optional(),
    workflow_id: NonEmptyStringSchema,
    attempt: z.number().int().positive(),
    source: NonEmptyStringSchema,
    event: NonEmptyStringSchema,
    action: NonEmptyStringSchema.optional(),
    route_target: RouteTargetSchema.optional(),
    subject: z
      .object({
        type: NonEmptyStringSchema,
        id: NonEmptyStringSchema
      })
      .strict()
      .optional(),
    started_at: NonEmptyStringSchema
  })
  .strict();
export type RunIdentity = z.infer<typeof RunIdentitySchema>;

export const WorkspaceRecordSchema = z
  .object({
    run_id: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
    preserved: z.boolean(),
    reason: NonEmptyStringSchema
  })
  .strict();
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;

export const FileExcerptSchema = z
  .object({
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    content: z.string(),
    truncated: z.boolean().optional()
  })
  .strict()
  .refine((excerpt) => excerpt.end_line >= excerpt.start_line, {
    message: "end_line must be greater than or equal to start_line",
    path: ["end_line"]
  });
export type FileExcerpt = z.infer<typeof FileExcerptSchema>;

export const ChangedFileSchema = z
  .object({
    path: NonEmptyStringSchema,
    status: z.enum([
      "added",
      "modified",
      "deleted",
      "renamed",
      "copied",
      "changed",
      "unmerged",
      "unknown"
    ]),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.boolean().optional(),
    is_large: z.boolean().optional(),
    is_lfs_pointer: z.boolean().optional(),
    is_submodule: z.boolean().optional(),
    previous_path: NonEmptyStringSchema.optional(),
    patch_truncated: z.boolean().optional(),
    patch_omitted_reason: z
      .enum(["binary", "deleted", "submodule", "diff_budget_exhausted"])
      .optional(),
    patch: z.string().nullable(),
    excerpt: FileExcerptSchema.nullable()
  })
  .strict();
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const RepoContextSchema = z
  .object({
    repository: RepositoryRefSchema,
    base_sha: NonEmptyStringSchema,
    head_sha: NonEmptyStringSchema,
    files: z.array(ChangedFileSchema),
    merge_base: NonEmptyStringSchema.optional(),
    changed_files_truncated: z.boolean().optional(),
    total_changed_files: z.number().int().nonnegative().optional(),
    changed_file_limit: z.number().int().positive().optional(),
    file_excerpts_truncated: z.array(NonEmptyStringSchema).optional(),
    git: z
      .object({
        merge_base: NonEmptyStringSchema,
        status_short: z.array(z.string())
      })
      .strict()
      .optional()
  })
  .strict();
export type RepoContext = z.infer<typeof RepoContextSchema>;

export const ReviewPlanSchema = z
  .object({
    summary: NonEmptyStringSchema,
    focus_areas: z.array(NonEmptyStringSchema),
    files_to_review: z.array(NonEmptyStringSchema)
  })
  .strict();
export type ReviewPlan = z.infer<typeof ReviewPlanSchema>;

export const EvidenceRefSchema = z
  .object({
    path: NonEmptyStringSchema,
    line_start: z.number().int().positive(),
    line_end: z.number().int().positive(),
    quote: z.string().optional()
  })
  .strict()
  .refine((evidence) => evidence.line_end >= evidence.line_start, {
    message: "line_end must be greater than or equal to line_start",
    path: ["line_end"]
  });
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const FindingSchema = z
  .object({
    title: NonEmptyStringSchema,
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    confidence: z.enum(["high", "medium", "low"]),
    description: NonEmptyStringSchema,
    evidence: z.array(EvidenceRefSchema),
    recommendation: NonEmptyStringSchema
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;

export const CodeReviewFindingsSchema = z
  .object({
    findings: z.array(FindingSchema),
    summary: z.string().optional()
  })
  .strict();
export type CodeReviewFindings = z.infer<typeof CodeReviewFindingsSchema>;

export const AcceptanceDecisionSchema = z
  .object({
    status: z.enum(["accepted", "rejected", "needs_human_review"]),
    summary: NonEmptyStringSchema,
    blocking_reasons: z.array(NonEmptyStringSchema),
    recommended_action: z.enum([
      "approve",
      "comment",
      "request_changes",
      "continue",
      "stop",
      "human_review"
    ])
  })
  .strict();
export type AcceptanceDecision = z.infer<typeof AcceptanceDecisionSchema>;

export const FinalReportSchema = z
  .object({
    invocation: InvocationSchema,
    plan: ReviewPlanSchema,
    findings: CodeReviewFindingsSchema,
    acceptance: AcceptanceDecisionSchema,
    workspace: WorkspaceRecordSchema.optional()
  })
  .strict();
export type FinalReport = z.infer<typeof FinalReportSchema>;

export const ErrorArtifactSchema = z
  .object({
    run_id: NonEmptyStringSchema.optional(),
    message: NonEmptyStringSchema,
    code: NonEmptyStringSchema.optional(),
    details: z.record(z.unknown()).optional()
  })
  .strict();
export type ErrorArtifact = z.infer<typeof ErrorArtifactSchema>;
