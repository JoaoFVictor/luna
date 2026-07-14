import { REPO_CONTEXT_LIMITS, CHANGED_FILE_STATUSES, PATCH_OMITTED_REASONS } from
  "./repo-context-policy.js";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const oidSchema = {
  type: "string",
  pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
} as const;
const countSchema = {
  type: "integer",
  minimum: 0,
  maximum: MAX_SAFE_INTEGER
} as const;
const boundedString = (maxLength: number, minLength = 1) => ({
  type: "string" as const,
  minLength,
  maxLength
});
const pathSchema = boundedString(REPO_CONTEXT_LIMITS.max_path_bytes);

export const FileExcerptJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["start_line", "end_line", "content"],
  properties: {
    start_line: { type: "integer", minimum: 1, maximum: MAX_SAFE_INTEGER },
    end_line: { type: "integer", minimum: 1, maximum: MAX_SAFE_INTEGER },
    content: boundedString(REPO_CONTEXT_LIMITS.max_excerpt_bytes, 0),
    truncated: { type: "boolean" }
  }
} as const;

export const ChangedFileJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "status", "additions", "deletions", "patch", "excerpt"],
  properties: {
    path: pathSchema,
    status: { type: "string", enum: CHANGED_FILE_STATUSES },
    additions: countSchema,
    deletions: countSchema,
    binary: { type: "boolean" },
    is_large: { type: "boolean" },
    is_lfs_pointer: { type: "boolean" },
    is_submodule: { type: "boolean" },
    previous_path: pathSchema,
    patch_truncated: { type: "boolean" },
    patch_omitted_reason: { type: "string", enum: PATCH_OMITTED_REASONS },
    patch: {
      anyOf: [
        boundedString(REPO_CONTEXT_LIMITS.max_total_diff_bytes, 0),
        { type: "null" }
      ]
    },
    excerpt: {
      anyOf: [FileExcerptJsonSchema, { type: "null" }]
    }
  }
} as const;

export const RepositoryRefJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["owner", "name", "full_name"],
  properties: {
    owner: boundedString(REPO_CONTEXT_LIMITS.max_repository_component_bytes),
    name: boundedString(REPO_CONTEXT_LIMITS.max_repository_component_bytes),
    full_name: boundedString(REPO_CONTEXT_LIMITS.max_repository_component_bytes)
  }
} as const;

export const RepoContextJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "repository", "base_sha", "head_sha", "merge_base", "files",
    "changed_files_truncated", "total_changed_files", "changed_file_limit",
    "changed_files_omitted_count", "file_excerpts_truncated", "git"
  ],
  properties: {
    repository: RepositoryRefJsonSchema,
    base_sha: oidSchema,
    head_sha: oidSchema,
    merge_base: oidSchema,
    allowed_checkout_shas: {
      type: "array",
      maxItems: REPO_CONTEXT_LIMITS.max_allowed_checkout_shas,
      items: oidSchema
    },
    files: {
      type: "array",
      maxItems: REPO_CONTEXT_LIMITS.max_changed_files,
      items: ChangedFileJsonSchema
    },
    changed_files_truncated: { type: "boolean" },
    total_changed_files: countSchema,
    changed_file_limit: {
      type: "integer", minimum: 1,
      maximum: REPO_CONTEXT_LIMITS.max_changed_files
    },
    changed_files_omitted_count: countSchema,
    file_excerpts_truncated: {
      type: "array",
      maxItems: REPO_CONTEXT_LIMITS.max_changed_files,
      items: pathSchema
    },
    git: {
      type: "object",
      additionalProperties: false,
      required: [
        "merge_base", "status_short", "status_short_omitted_count",
        "status_short_truncated_count"
      ],
      properties: {
        merge_base: oidSchema,
        status_short: {
          type: "array",
          maxItems: REPO_CONTEXT_LIMITS.max_git_status_entries,
          items: boundedString(REPO_CONTEXT_LIMITS.max_git_status_bytes)
        },
        status_short_omitted_count: countSchema,
        status_short_truncated_count: countSchema
      }
    }
  }
} as const;
