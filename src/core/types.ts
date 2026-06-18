import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);

export const TargetSchema = z.literal("github_pr");
export type Target = z.infer<typeof TargetSchema>;

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

export const InvocationSchema = z
  .object({
    target: TargetSchema,
    owner: NonEmptyStringSchema,
    repo: NonEmptyStringSchema,
    pull_number: z.number().int().positive(),
    base_repository: RepositoryRefSchema,
    head_repository: HeadRepositoryRefSchema,
    references: z
      .object({
        base_sha: NonEmptyStringSchema,
        head_sha: NonEmptyStringSchema
      })
      .strict()
  })
  .strict();
export type Invocation = z.infer<typeof InvocationSchema>;

export const RepositoryConfigSchema = z
  .object({
    owner: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    full_name: NonEmptyStringSchema.optional(),
    default_branch: NonEmptyStringSchema.optional()
  })
  .strict();
export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;

export const RepositoriesConfigSchema = z
  .object({
    repositories: z.record(NonEmptyStringSchema, RepositoryConfigSchema)
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
    profiles: z.record(NonEmptyStringSchema, ModelProfileSchema)
  })
  .strict();
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

export const RouteSchema = z
  .object({
    profile: NonEmptyStringSchema,
    prompt: NonEmptyStringSchema.optional()
  })
  .strict();
export type Route = z.infer<typeof RouteSchema>;

export const RoutingConfigSchema = z
  .object({
    routes: z.record(NonEmptyStringSchema, RouteSchema)
  })
  .strict();
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

export const WorkspaceConfigSchema = z
  .object({
    root: NonEmptyStringSchema,
    runs_dir: NonEmptyStringSchema.optional(),
    preserve: z.boolean().optional()
  })
  .strict();
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export const RunIdentitySchema = z
  .object({
    run_id: NonEmptyStringSchema,
    target: TargetSchema,
    started_at: NonEmptyStringSchema.optional()
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
    content: z.string()
  })
  .strict();
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
    previous_path: NonEmptyStringSchema.optional(),
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
    files: z.array(ChangedFileSchema)
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
  .strict();
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
    decision: z.enum(["approve", "comment", "request_changes"]),
    summary: NonEmptyStringSchema,
    blocking_findings: z.array(NonEmptyStringSchema)
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
