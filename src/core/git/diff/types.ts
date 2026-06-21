import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);

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
