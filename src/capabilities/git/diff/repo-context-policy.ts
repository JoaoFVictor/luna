export const REPO_CONTEXT_LIMITS = {
  max_changed_files: 100,
  max_total_diff_bytes: 4 * 1024 * 1024,
  max_excerpt_bytes: 16 * 1024,
  max_path_bytes: 4_096,
  max_repository_component_bytes: 1_024,
  max_allowed_checkout_shas: 8,
  max_git_status_entries: 1_000,
  max_git_status_bytes: 4_096
} as const;

export const CHANGED_FILE_STATUSES = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "changed",
  "unmerged",
  "unknown"
] as const;

export const PATCH_OMITTED_REASONS = [
  "binary",
  "deleted",
  "submodule",
  "diff_budget_exhausted"
] as const;
