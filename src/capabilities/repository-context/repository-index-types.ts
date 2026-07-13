import type { Candidate } from "./file-analysis.js";
import type { GraphTopology } from "./graph-ranking.js";
import type { LexicalCorpus } from "./lexical-ranking.js";
import type { SymbolEngine } from "./symbol-analysis/index.js";
import type { REPOSITORY_INDEX_RESOURCE_POLICY } from "./repository-index-policy.js";

export type RepositoryIndexSnapshot = {
  readonly id: string;
  readonly head_sha: string;
  readonly dirty: boolean;
  readonly indexer_version: string;
  readonly policy_hash: string;
};

export type RepositoryIndexCoverage = {
  readonly inventory_files: number;
  readonly eligible_files: number;
  readonly indexed_files: number;
  readonly excluded_files: number;
  readonly policy_excluded_files: number;
  readonly binary_excluded_files: number;
  readonly sensitive_excluded_files: number;
  readonly non_regular_excluded_files: number;
  readonly generic_text_files: number;
  readonly unavailable_files: number;
  readonly complete: boolean;
  readonly languages: readonly string[];
  readonly symbol_engines: readonly SymbolEngine[];
};

export type RepositoryIndexBuildStats = {
  readonly inventory_path_bytes: number;
  readonly planned_source_bytes: number;
  readonly indexed_source_bytes: number;
  readonly retained_index_bytes: number;
  readonly retained_candidate_bytes: number;
  readonly retained_derived_bytes: number;
  readonly peak_inflight_source_bytes: number;
  readonly read_concurrency: number;
  readonly preflight_duration_ms: number;
  readonly build_duration_ms: number;
  readonly limits: Readonly<typeof REPOSITORY_INDEX_RESOURCE_POLICY>;
};

export type RepositoryIndex = {
  readonly snapshot: RepositoryIndexSnapshot;
  readonly coverage: RepositoryIndexCoverage;
  readonly candidates: readonly Candidate[];
  readonly import_resolution_signature: string;
  readonly lexical_corpus: LexicalCorpus;
  readonly graph_topology: GraphTopology;
  readonly warnings: readonly string[];
  readonly stats: RepositoryIndexBuildStats;
};
