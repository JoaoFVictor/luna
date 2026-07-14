import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  CHANGED_FILE_STATUSES,
  PATCH_OMITTED_REASONS,
  REPO_CONTEXT_LIMITS
} from "./repo-context-policy.js";

const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveCountSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

function boundedUtf8String(maxBytes: number, allowEmpty = false) {
  const schema = allowEmpty ? z.string() : z.string().min(1);
  return schema.max(maxBytes).refine(
    (value) => Buffer.byteLength(value, "utf8") <= maxBytes,
    { message: `String must not exceed ${maxBytes} UTF-8 bytes` }
  );
}

const RepositoryComponentSchema = boundedUtf8String(
  REPO_CONTEXT_LIMITS.max_repository_component_bytes
);
const PathSchema = boundedUtf8String(REPO_CONTEXT_LIMITS.max_path_bytes);
export const GitObjectIdSchema = z.string().regex(
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu,
  "Git object id must be a full 40- or 64-character hexadecimal OID"
);

const RepositoryRefShape = {
  owner: RepositoryComponentSchema,
  name: RepositoryComponentSchema,
  full_name: RepositoryComponentSchema
} as const;
const repositoryFullNameMatches = (repository: {
  readonly owner: string;
  readonly name: string;
  readonly full_name: string;
}) => repository.full_name === `${repository.owner}/${repository.name}`;

export const RepositoryRefSchema = z
  .object(RepositoryRefShape)
  .strict()
  .refine(repositoryFullNameMatches, {
    message: "Repository full_name must match owner/name",
    path: ["full_name"]
  });
export type RepositoryRef = z.infer<typeof RepositoryRefSchema>;

export const HeadRepositoryRefSchema = z
  .object({ ...RepositoryRefShape, fork: z.boolean().optional() })
  .strict()
  .refine(repositoryFullNameMatches, {
    message: "Repository full_name must match owner/name",
    path: ["full_name"]
  });
export type HeadRepositoryRef = z.infer<typeof HeadRepositoryRefSchema>;

export const FileExcerptSchema = z
  .object({
    start_line: PositiveCountSchema,
    end_line: PositiveCountSchema,
    content: boundedUtf8String(REPO_CONTEXT_LIMITS.max_excerpt_bytes, true),
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
    path: PathSchema,
    status: z.enum(CHANGED_FILE_STATUSES),
    additions: CountSchema,
    deletions: CountSchema,
    binary: z.boolean().optional(),
    is_large: z.boolean().optional(),
    is_lfs_pointer: z.boolean().optional(),
    is_submodule: z.boolean().optional(),
    previous_path: PathSchema.optional(),
    patch_truncated: z.boolean().optional(),
    patch_omitted_reason: z.enum(PATCH_OMITTED_REASONS).optional(),
    patch: boundedUtf8String(
      REPO_CONTEXT_LIMITS.max_total_diff_bytes,
      true
    ).nullable(),
    excerpt: FileExcerptSchema.nullable()
  })
  .strict()
  .superRefine((file, context) => {
    if (file.patch === null && file.patch_omitted_reason === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["patch_omitted_reason"],
        message: "A null patch must declare patch_omitted_reason"
      });
    }
    if (file.patch !== null && file.patch_omitted_reason !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["patch_omitted_reason"],
        message: "A present patch cannot declare patch_omitted_reason"
      });
    }
    if (file.patch_truncated === true && file.patch === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["patch_truncated"],
        message: "A truncated patch must include captured patch content"
      });
    }
  });
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const RepoContextSchema = z
  .object({
    repository: RepositoryRefSchema,
    base_sha: GitObjectIdSchema,
    head_sha: GitObjectIdSchema,
    merge_base: GitObjectIdSchema,
    allowed_checkout_shas: z.array(GitObjectIdSchema)
      .max(REPO_CONTEXT_LIMITS.max_allowed_checkout_shas).optional(),
    files: z.array(ChangedFileSchema).max(REPO_CONTEXT_LIMITS.max_changed_files),
    changed_files_truncated: z.boolean(),
    total_changed_files: CountSchema,
    changed_file_limit: z.number().int().positive()
      .max(REPO_CONTEXT_LIMITS.max_changed_files),
    changed_files_omitted_count: CountSchema,
    file_excerpts_truncated: z.array(PathSchema)
      .max(REPO_CONTEXT_LIMITS.max_changed_files),
    git: z
      .object({
        merge_base: GitObjectIdSchema,
        status_short: z.array(
          boundedUtf8String(REPO_CONTEXT_LIMITS.max_git_status_bytes)
        ).max(REPO_CONTEXT_LIMITS.max_git_status_entries),
        status_short_omitted_count: CountSchema,
        status_short_truncated_count: CountSchema
      })
      .strict()
  })
  .strict()
  .superRefine((repoContext, context) => {
    const expectedCapturedFiles = Math.min(
      repoContext.total_changed_files,
      repoContext.changed_file_limit
    );
    const expectedOmittedFiles = repoContext.total_changed_files - expectedCapturedFiles;
    if (repoContext.files.length !== expectedCapturedFiles) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message: "Captured files must equal min(total_changed_files, changed_file_limit)"
      });
    }
    if (repoContext.changed_files_omitted_count !== expectedOmittedFiles) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changed_files_omitted_count"],
        message: "changed_files_omitted_count is inconsistent with captured files"
      });
    }
    if (repoContext.changed_files_truncated !== (expectedOmittedFiles > 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changed_files_truncated"],
        message: "changed_files_truncated is inconsistent with omitted files"
      });
    }
    if (repoContext.git.merge_base !== repoContext.merge_base) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["git", "merge_base"],
        message: "git.merge_base must match merge_base"
      });
    }
    if (repoContext.git.status_short_truncated_count > repoContext.git.status_short.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["git", "status_short_truncated_count"],
        message: "status_short_truncated_count exceeds captured status entries"
      });
    }
    const truncatedExcerptPaths = repoContext.files
      .filter((file) => file.excerpt?.truncated === true)
      .map((file) => file.path)
      .sort();
    const declaredTruncatedPaths = [...new Set(repoContext.file_excerpts_truncated)].sort();
    if (
      declaredTruncatedPaths.length !== repoContext.file_excerpts_truncated.length ||
      JSON.stringify(declaredTruncatedPaths) !== JSON.stringify(truncatedExcerptPaths)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["file_excerpts_truncated"],
        message: "file_excerpts_truncated must uniquely identify every truncated excerpt"
      });
    }
    const capturedDiffBytes = repoContext.files.reduce(
      (total, file) => total + Buffer.byteLength(file.patch ?? "", "utf8"),
      0
    );
    if (capturedDiffBytes > REPO_CONTEXT_LIMITS.max_total_diff_bytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message: `Captured patches exceed ${REPO_CONTEXT_LIMITS.max_total_diff_bytes} UTF-8 bytes`
      });
    }
  });
export type RepoContext = z.infer<typeof RepoContextSchema>;
