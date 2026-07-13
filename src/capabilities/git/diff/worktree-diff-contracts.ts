import { Buffer } from "node:buffer";
import { z } from "zod";
import { ApprovedWorktreeSnapshotSchema } from "../worktree-snapshot.js";

export const WORKTREE_DIFF_LIMITS = {
  max_diff_bytes: 4 * 1024 * 1024,
  max_status_files: 10_000,
  max_status_path_bytes: 4 * 1024 * 1024,
  max_untracked_files: 1_000,
  max_untracked_summary_bytes: 4 * 1024 * 1024,
  max_git_metadata_bytes: 8 * 1024 * 1024,
  untracked_read_concurrency: 8
} as const;

const RepositoryPathSchema = z.string().min(1).max(4_096).refine((value) =>
  Buffer.byteLength(value, "utf8") <= 4_096, "Path exceeds 4096 UTF-8 bytes"
);
export const FileExcerptSchema = z.object({
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  content: z.string().max(WORKTREE_DIFF_LIMITS.max_untracked_summary_bytes),
  truncated: z.boolean().optional()
}).strict();
export type FileExcerpt = z.infer<typeof FileExcerptSchema>;

export const UntrackedFileSummarySchema = z.object({
  path: RepositoryPathSchema,
  excerpt: FileExcerptSchema,
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative(),
  max_bytes: z.number().int().nonnegative(),
  symlink: z.boolean().optional(),
  omitted: z.boolean().optional(),
  omitted_reason: z.enum([
    "symlink", "sensitive_path", "unavailable_or_unsafe", "non_regular"
  ]).optional()
}).strict();
export type UntrackedFileSummary = z.infer<typeof UntrackedFileSummarySchema>;

export const WorktreeDiffFileSchema = z.object({
  path: RepositoryPathSchema,
  status: z.enum([
    "modified", "added", "deleted", "renamed", "copied", "untracked",
    "changed", "unmerged", "unknown"
  ]),
  index_status: z.string().min(1).max(1),
  worktree_status: z.string().min(1).max(1),
  previous_path: RepositoryPathSchema.optional(),
  binary: z.boolean().optional(),
  is_submodule: z.boolean().optional(),
  is_large: z.boolean().optional(),
  untracked_summary: UntrackedFileSummarySchema.optional()
}).strict();
export type WorktreeDiffFile = z.infer<typeof WorktreeDiffFileSchema>;
export type WorktreeFileStatus = WorktreeDiffFile["status"];

export const WorktreeDiffSchema = z.object({
  files: z.array(WorktreeDiffFileSchema).max(WORKTREE_DIFF_LIMITS.max_status_files),
  untracked_files: z.array(RepositoryPathSchema).max(WORKTREE_DIFF_LIMITS.max_untracked_files),
  untracked_summaries: z.array(UntrackedFileSummarySchema)
    .max(WORKTREE_DIFF_LIMITS.max_untracked_files),
  staged_diff: z.string().max(WORKTREE_DIFF_LIMITS.max_diff_bytes),
  unstaged_diff: z.string().max(WORKTREE_DIFF_LIMITS.max_diff_bytes),
  staged_diff_truncated: z.boolean(),
  unstaged_diff_truncated: z.boolean(),
  max_diff_bytes: z.number().int().positive().max(WORKTREE_DIFF_LIMITS.max_diff_bytes),
  status_files_omitted_count: z.number().int().nonnegative(),
  untracked_files_omitted_count: z.number().int().nonnegative(),
  untracked_summary_bytes: z.number().int().nonnegative(),
  max_untracked_summary_bytes: z.number().int().positive()
    .max(WORKTREE_DIFF_LIMITS.max_untracked_summary_bytes),
  approved_snapshot: ApprovedWorktreeSnapshotSchema.optional()
}).strict().superRefine((diff, context) => {
  for (const [field, value] of [
    ["staged_diff", diff.staged_diff],
    ["unstaged_diff", diff.unstaged_diff]
  ] as const) {
    if (Buffer.byteLength(value, "utf8") > diff.max_diff_bytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} exceeds max_diff_bytes`
      });
    }
  }
  const summaryBytes = diff.untracked_summaries.reduce((total, summary) =>
    total + Buffer.byteLength(summary.excerpt.content, "utf8"), 0
  );
  if (summaryBytes > diff.max_untracked_summary_bytes ||
    summaryBytes !== diff.untracked_summary_bytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["untracked_summary_bytes"],
      message: "untracked summary bytes must match content and remain within its declared maximum"
    });
  }
});
export type WorktreeDiff = z.infer<typeof WorktreeDiffSchema>;

const FileExcerptJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["start_line", "end_line", "content"],
  properties: {
    start_line: { type: "integer", minimum: 1 },
    end_line: { type: "integer", minimum: 1 },
    content: { type: "string", maxLength: WORKTREE_DIFF_LIMITS.max_untracked_summary_bytes },
    truncated: { type: "boolean" }
  }
} as const;

const UntrackedFileSummaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "excerpt", "truncated", "bytes", "max_bytes"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 4096 },
    excerpt: FileExcerptJsonSchema,
    truncated: { type: "boolean" },
    bytes: { type: "integer", minimum: 0 },
    max_bytes: { type: "integer", minimum: 0 },
    symlink: { type: "boolean" },
    omitted: { type: "boolean" },
    omitted_reason: {
      type: "string",
      enum: ["symlink", "sensitive_path", "unavailable_or_unsafe", "non_regular"]
    }
  }
} as const;

const WorktreeDiffFileJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "status", "index_status", "worktree_status"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 4096 },
    status: {
      type: "string",
      enum: [
        "modified", "added", "deleted", "renamed", "copied", "untracked",
        "changed", "unmerged", "unknown"
      ]
    },
    index_status: { type: "string", minLength: 1, maxLength: 1 },
    worktree_status: { type: "string", minLength: 1, maxLength: 1 },
    previous_path: { type: "string", minLength: 1, maxLength: 4096 },
    binary: { type: "boolean" },
    is_submodule: { type: "boolean" },
    is_large: { type: "boolean" },
    untracked_summary: UntrackedFileSummaryJsonSchema
  }
} as const;

export const WorktreeDiffJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "files", "untracked_files", "untracked_summaries", "staged_diff",
    "unstaged_diff", "staged_diff_truncated", "unstaged_diff_truncated", "max_diff_bytes",
    "status_files_omitted_count", "untracked_files_omitted_count",
    "untracked_summary_bytes", "max_untracked_summary_bytes"
  ],
  properties: {
    files: { type: "array", maxItems: WORKTREE_DIFF_LIMITS.max_status_files, items: WorktreeDiffFileJsonSchema },
    untracked_files: {
      type: "array", maxItems: WORKTREE_DIFF_LIMITS.max_untracked_files,
      items: { type: "string", minLength: 1, maxLength: 4096 }
    },
    untracked_summaries: {
      type: "array", maxItems: WORKTREE_DIFF_LIMITS.max_untracked_files,
      items: UntrackedFileSummaryJsonSchema
    },
    staged_diff: { type: "string", maxLength: WORKTREE_DIFF_LIMITS.max_diff_bytes },
    unstaged_diff: { type: "string", maxLength: WORKTREE_DIFF_LIMITS.max_diff_bytes },
    staged_diff_truncated: { type: "boolean" },
    unstaged_diff_truncated: { type: "boolean" },
    max_diff_bytes: { type: "integer", minimum: 1, maximum: WORKTREE_DIFF_LIMITS.max_diff_bytes },
    status_files_omitted_count: { type: "integer", minimum: 0 },
    untracked_files_omitted_count: { type: "integer", minimum: 0 },
    untracked_summary_bytes: { type: "integer", minimum: 0 },
    max_untracked_summary_bytes: {
      type: "integer", minimum: 1,
      maximum: WORKTREE_DIFF_LIMITS.max_untracked_summary_bytes
    },
    approved_snapshot: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "head_sha", "tree_oid", "changed_paths"],
      properties: {
        kind: { const: "git_worktree_tree.v1" },
        head_sha: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
        tree_oid: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
        changed_paths: {
          type: "array",
          maxItems: WORKTREE_DIFF_LIMITS.max_status_files,
          items: { type: "string", minLength: 1, maxLength: 4096 }
        }
      }
    }
  }
} as const;
