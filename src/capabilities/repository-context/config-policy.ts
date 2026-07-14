export const REPOSITORY_CONTEXT_LIMITS = {
  max_related_files: 100,
  max_seed_files: 100,
  max_excerpt_bytes: 16 * 1024
} as const;

export const REPOSITORY_CONTEXT_DEFAULTS = {
  max_related_files: 12,
  max_seed_files: 5,
  max_excerpt_bytes: 4_000
} as const;

export const REPOSITORY_CONTEXT_INPUT_LIMITS = {
  task_text_bytes: 128 * 1024,
  task_paths: 100,
  task_path_bytes: 4_096,
  task_symbols: 100,
  task_symbol_bytes: 1_024
} as const;

export const REPOSITORY_CONTEXT_OUTPUT_LIMITS = {
  query_terms: 256,
  changed_files: 1_000,
  path_diagnostics: 1_000,
  warnings: 100,
  edges: 1_000,
  edge_text_bytes: 1_024
} as const;
