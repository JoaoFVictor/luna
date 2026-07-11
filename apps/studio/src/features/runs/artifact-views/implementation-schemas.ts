import { z } from "zod"

import {
  ArtifactRawPreviewTextSchema,
  ArtifactViewNonEmptyTextSchema,
  ArtifactViewTextSchema,
  MAX_ARTIFACT_VIEW_ITEMS,
  RepositoryRelativePathSchema,
} from "./common"

const CountSchema = z.number().int().safe().nonnegative()
const PositiveCountSchema = z.number().int().safe().positive()
const RevisionSchema = z.string().min(1).max(256)

export const ImplementationPlanViewSchema = z
  .object({
    summary: ArtifactViewNonEmptyTextSchema,
    steps: z.array(ArtifactViewNonEmptyTextSchema).max(MAX_ARTIFACT_VIEW_ITEMS),
    files: z.array(RepositoryRelativePathSchema).max(MAX_ARTIFACT_VIEW_ITEMS).optional(),
    validation: z
      .array(ArtifactViewNonEmptyTextSchema)
      .max(MAX_ARTIFACT_VIEW_ITEMS)
      .optional(),
    risks: z.array(ArtifactViewNonEmptyTextSchema).max(MAX_ARTIFACT_VIEW_ITEMS),
  })
  .strict()

const ValidationCommandSchema = z
  .object({
    cmd: ArtifactViewNonEmptyTextSchema,
    args: z.array(ArtifactViewTextSchema).max(200).optional(),
    exit_code: z.number().int().safe().nullable(),
    stdout: ArtifactRawPreviewTextSchema,
    stderr: ArtifactRawPreviewTextSchema,
    stdout_truncated: z.boolean(),
    stderr_truncated: z.boolean(),
    duration_ms: CountSchema,
    timed_out: z.boolean(),
  })
  .strict()

const ValidationContractSchema = z
  .object({
    passed: z.boolean(),
    commands: z.array(ValidationCommandSchema).max(100).optional(),
  })
  .strict()

export const ImplementationValidationViewSchema = ValidationContractSchema.transform(
  (value) => ({
    passed: value.passed,
    commands: (value.commands ?? []).map((command, index) => ({
      ordinal: index + 1,
      exit_code: command.exit_code,
      duration_ms: command.duration_ms,
      timed_out: command.timed_out,
      stdout_truncated: command.stdout_truncated,
      stderr_truncated: command.stderr_truncated,
    })),
  }),
)

const FileExcerptSchema = z
  .object({
    start_line: PositiveCountSchema,
    end_line: PositiveCountSchema,
    content: ArtifactRawPreviewTextSchema,
    truncated: z.boolean().optional(),
  })
  .strict()

const UntrackedFileSummarySchema = z
  .object({
    path: RepositoryRelativePathSchema,
    excerpt: FileExcerptSchema,
    truncated: z.boolean(),
    bytes: CountSchema,
    max_bytes: CountSchema,
    symlink: z.boolean().optional(),
    omitted: z.boolean().optional(),
    omitted_reason: z.enum(["symlink", "sensitive_path"]).optional(),
  })
  .strict()

const DiffFileSchema = z
  .object({
    path: RepositoryRelativePathSchema,
    status: z.enum([
      "modified",
      "added",
      "deleted",
      "renamed",
      "copied",
      "untracked",
      "changed",
      "unmerged",
      "unknown",
    ]),
    index_status: z.string().max(2),
    worktree_status: z.string().max(2),
    previous_path: RepositoryRelativePathSchema.optional(),
    binary: z.boolean().optional(),
    is_submodule: z.boolean().optional(),
    is_large: z.boolean().optional(),
    untracked_summary: UntrackedFileSummarySchema.optional(),
  })
  .strict()

export const ImplementationDiffViewSchema = z
  .object({
    files: z.array(DiffFileSchema).max(MAX_ARTIFACT_VIEW_ITEMS),
    untracked_files: z
      .array(RepositoryRelativePathSchema)
      .max(MAX_ARTIFACT_VIEW_ITEMS),
    untracked_summaries: z
      .array(UntrackedFileSummarySchema)
      .max(MAX_ARTIFACT_VIEW_ITEMS),
    staged_diff: ArtifactRawPreviewTextSchema,
    unstaged_diff: ArtifactRawPreviewTextSchema,
    staged_diff_truncated: z.boolean(),
    unstaged_diff_truncated: z.boolean(),
    max_diff_bytes: CountSchema,
  })
  .strict()
  .transform((value) => ({
    files: value.files.map((file) => ({
      path: file.path,
      status: file.status,
      binary: file.binary === true,
      submodule: file.is_submodule === true,
      large: file.is_large === true,
    })),
    untracked_file_count: value.untracked_files.length,
    staged_diff_truncated: value.staged_diff_truncated,
    unstaged_diff_truncated: value.unstaged_diff_truncated,
  }))

const GateSchema = z
  .object({
    id: ArtifactViewNonEmptyTextSchema,
    type: ArtifactViewNonEmptyTextSchema,
    passed: z.boolean(),
    feedback: ArtifactViewTextSchema.optional(),
    output: z.unknown().optional(),
  })
  .strict()

const AttemptSchema = z
  .object({
    attempt: PositiveCountSchema,
    phase: z.enum(["initial", "repair"]),
    agent_output: z.unknown().optional(),
    agent_error: z
      .object({
        message: ArtifactViewNonEmptyTextSchema,
        code: ArtifactViewNonEmptyTextSchema.optional(),
      })
      .strict()
      .optional(),
    validation: ValidationContractSchema.optional(),
    gate_results: z.array(GateSchema).max(100).optional(),
    diff_summary: z.unknown().optional(),
    duration_ms: CountSchema.optional(),
    truncated: z.boolean().optional(),
  })
  .strict()

export const ImplementationGatesViewSchema = z
  .object({
    status: z.enum(["passed", "failed"]),
    attempts_exhausted: z.boolean(),
    attempts: z.array(AttemptSchema).max(50),
    validation: ValidationContractSchema,
    final_validation: ValidationContractSchema,
    gates: z.array(GateSchema).max(100),
    result: z
      .object({ status: ArtifactViewNonEmptyTextSchema })
      .passthrough(),
  })
  .strict()
  .transform((value) => ({
    status: value.status,
    attempts_exhausted: value.attempts_exhausted,
    attempt_count: value.attempts.length,
    final_validation_passed: value.final_validation.passed,
    gates: value.gates.map((gate) => ({
      id: gate.id,
      type: gate.type,
      passed: gate.passed,
    })),
  }))

export const ImplementationWorktreeViewSchema = z
  .object({
    operation_id: z.literal("repository-workspace.capture"),
    run_id: ArtifactViewNonEmptyTextSchema,
    workspace_id: ArtifactViewNonEmptyTextSchema,
    path: ArtifactViewNonEmptyTextSchema,
    preserved: z.boolean(),
    reason: ArtifactViewNonEmptyTextSchema,
    lifecycle: z.enum(["active", "released", "failed", "cancelled", "timed_out"]),
    captured_at: z.string().datetime({ offset: true }),
    repository_id: ArtifactViewNonEmptyTextSchema,
    remote: ArtifactViewNonEmptyTextSchema,
    base_ref: ArtifactViewNonEmptyTextSchema,
    base_sha: RevisionSchema,
    branch: ArtifactViewNonEmptyTextSchema,
  })
  .strict()
  .transform((value) => ({
    preserved: value.preserved,
    reason: value.reason,
    lifecycle: value.lifecycle,
    repository_id: value.repository_id,
    remote: value.remote,
    base_ref: value.base_ref,
    base_sha: value.base_sha,
    branch: value.branch,
  }))

const GitCommitResultSchema = z
  .object({
    operation_id: z.literal("git.commit"),
    workspace_id: ArtifactViewNonEmptyTextSchema,
    branch: ArtifactViewNonEmptyTextSchema,
    head_sha: RevisionSchema,
    commit_sha: RevisionSchema,
    message: ArtifactViewNonEmptyTextSchema,
    paths: z.array(RepositoryRelativePathSchema).max(MAX_ARTIFACT_VIEW_ITEMS).optional(),
    adopted: z.boolean(),
  })
  .strict()
  .transform((value) => ({
    status: "committed" as const,
    branch: value.branch,
    commit_sha: value.commit_sha,
    adopted: value.adopted,
  }))

const CommitLifecycleSchema = z
  .object({
    enabled: z.literal(true),
    skipped: z.literal(false),
    branch: ArtifactViewNonEmptyTextSchema,
    commit_sha: RevisionSchema,
  })
  .strict()
  .transform((value) => ({
    status: "committed" as const,
    branch: value.branch,
    commit_sha: value.commit_sha,
    adopted: undefined,
  }))

const GitCommitSkippedSchema = z
  .object({
    operation_id: z.literal("git.commit").optional(),
    enabled: z.boolean(),
    skipped: z.literal(true),
    reason: ArtifactViewNonEmptyTextSchema,
  })
  .strict()
  .transform((value) => ({
    status: "skipped" as const,
    enabled: value.enabled,
    reason: value.reason,
  }))

export const ImplementationCommitViewSchema = z.union([
  GitCommitResultSchema,
  CommitLifecycleSchema,
  GitCommitSkippedSchema,
])

const GitPushResultSchema = z
  .object({
    operation_id: z.literal("git.push_branch"),
    workspace_id: ArtifactViewNonEmptyTextSchema,
    branch: ArtifactViewNonEmptyTextSchema,
    remote: ArtifactViewNonEmptyTextSchema,
    commit_sha: RevisionSchema,
    pushed: z.boolean(),
  })
  .strict()
  .transform((value) => ({
    status: value.pushed ? "pushed" as const : "not_pushed" as const,
    branch: value.branch,
    remote: value.remote,
    commit_sha: value.commit_sha,
  }))

const PushLifecycleSchema = z
  .object({
    enabled: z.literal(true),
    skipped: z.literal(false),
    remote: ArtifactViewNonEmptyTextSchema,
    branch: ArtifactViewNonEmptyTextSchema,
  })
  .strict()
  .transform((value) => ({
    status: "pushed" as const,
    branch: value.branch,
    remote: value.remote,
    commit_sha: undefined,
  }))

const GitPushSkippedSchema = z
  .object({
    operation_id: z.literal("git.push_branch").optional(),
    enabled: z.boolean(),
    skipped: z.literal(true),
    reason: ArtifactViewNonEmptyTextSchema,
  })
  .strict()
  .transform((value) => ({
    status: "skipped" as const,
    enabled: value.enabled,
    reason: value.reason,
  }))

export const ImplementationPushViewSchema = z.union([
  GitPushResultSchema,
  PushLifecycleSchema,
  GitPushSkippedSchema,
])

const ChangeRequestCreatedSchema = z
  .object({
    operation_id: z.literal("change-request.create"),
    enabled: z.literal(true),
    skipped: z.literal(false),
    provider: ArtifactViewNonEmptyTextSchema,
    provider_id: ArtifactViewNonEmptyTextSchema,
    external_id: ArtifactViewNonEmptyTextSchema,
    url: z.string().min(1).max(2_048),
    title: ArtifactViewNonEmptyTextSchema,
    source_branch: ArtifactViewNonEmptyTextSchema,
    target_branch: ArtifactViewNonEmptyTextSchema,
    adopted: z.boolean(),
  })
  .strict()
  .transform((value) => ({
    status: "created" as const,
    provider: value.provider,
    external_id: value.external_id,
    title: value.title,
    source_branch: value.source_branch,
    target_branch: value.target_branch,
    adopted: value.adopted,
  }))

const ChangeRequestSkippedSchema = z
  .object({
    operation_id: z.literal("change-request.create"),
    enabled: z.boolean(),
    skipped: z.literal(true),
    reason: ArtifactViewNonEmptyTextSchema,
    adopted: z.literal(false),
  })
  .strict()
  .transform((value) => ({
    status: "skipped" as const,
    enabled: value.enabled,
    reason: value.reason,
  }))

export const ImplementationChangeRequestViewSchema = z.union([
  ChangeRequestCreatedSchema,
  ChangeRequestSkippedSchema,
])
