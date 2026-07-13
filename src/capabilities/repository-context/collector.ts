import path from "node:path";
import type { RepoContext } from "../git/diff/types.js";
import {
  type Candidate,
  unique
} from "./file-analysis.js";
import {
  primaryReasonForRelation,
  scoreCandidates,
  selectRelatedFiles,
  sourceFrom,
  toRankedRelatedFile,
  toRelatedFile
} from "./ranking.js";
import type {
  RelatedContext,
  RelatedContextConfig,
  RelatedContextFile,
  RelatedContextNode,
  RepositoryContextQuery,
  RelatedContextTask,
  RelatedContextWorktreeDiff
} from "./contracts.js";
import {
  acquireRepositoryQuerySlot,
  repositoryIndex
} from "./repository-index.js";
import type { RepositoryRef } from "../git/diff/types.js";
import {
  REPOSITORY_CONTEXT_DEFAULTS,
  REPOSITORY_CONTEXT_OUTPUT_LIMITS
} from "./config-policy.js";
import { seedFromInput } from "./context-seed.js";
import { edgesFrom } from "./context-edges.js";
import type { RepositoryContextIndexPolicy } from "./repository-index-policy.js";

const MAX_OMITTED_PATHS = 50;

function resolveRelatedContextConfig(
  config: RelatedContextConfig | undefined
): Required<RelatedContextConfig> {
  const resolved = config ?? {};
  const maxRelatedFiles = resolved.max_related_files ??
    REPOSITORY_CONTEXT_DEFAULTS.max_related_files;

  return {
    enabled: resolved.enabled ?? true,
    max_related_files: maxRelatedFiles,
    max_seed_files: Math.min(
      resolved.max_seed_files ?? REPOSITORY_CONTEXT_DEFAULTS.max_seed_files,
      maxRelatedFiles
    ),
    max_excerpt_bytes: resolved.max_excerpt_bytes ??
      REPOSITORY_CONTEXT_DEFAULTS.max_excerpt_bytes,
    include_tests: resolved.include_tests ?? true,
    include_docs: resolved.include_docs ?? true,
    include_configs: resolved.include_configs ?? true
  };
}

function confidenceFrom(score: number): "high" | "medium" | "low" {
  if (score >= 70) {
    return "high";
  }
  if (score >= 28) {
    return "medium";
  }
  return "low";
}

function nodesFrom(files: readonly RelatedContextFile[]): RelatedContextNode[] {
  return files.map((file) => ({
    id: file.path,
    path: file.path,
    kind: file.relation,
    ...(file.language === undefined ? {} : { language: file.language }),
    source: sourceFrom(file.relation),
    reason: primaryReasonForRelation(file),
    confidence: confidenceFrom(file.score)
  }));
}

function symbolWarningsFrom(
  candidates: readonly Candidate[],
  selectedPaths: ReadonlySet<string>
): string[] {
  return unique(candidates.filter((candidate) => selectedPaths.has(candidate.path)).flatMap((candidate) =>
    candidate.symbol_graph.warnings.map((warning) => `${candidate.path}: ${warning}`)
  )).slice(0, 40);
}

async function collectRelatedContextInternal(input: {
  readonly root: string;
  readonly repository?: RepositoryRef;
  readonly repoContext?: RepoContext;
  readonly task?: RelatedContextTask;
  readonly worktreeDiff?: RelatedContextWorktreeDiff;
  readonly config?: RelatedContextConfig;
  readonly indexPolicy?: RepositoryContextIndexPolicy;
  readonly expectedSnapshotId?: string;
  readonly signal?: AbortSignal;
}): Promise<RelatedContext | RepositoryContextQuery> {
  const config = resolveRelatedContextConfig(input.config);
  if (
    input.repoContext !== undefined &&
    input.repository !== undefined &&
    input.repoContext.repository.full_name.toLowerCase() !==
      input.repository.full_name.toLowerCase()
  ) {
    throw new Error(
      `Repository context belongs to ${input.repoContext.repository.full_name}, not ${input.repository.full_name}.`
    );
  }
  const repositoryRoot = path.resolve(input.root);
  const index = await repositoryIndex({
    root: repositoryRoot,
    policy: input.indexPolicy,
    signal: input.signal
  });
  if (
    input.expectedSnapshotId !== undefined &&
    index.snapshot.id !== input.expectedSnapshotId
  ) {
    throw new Error(
      `Repository context snapshot changed: expected ${input.expectedSnapshotId}, received ${index.snapshot.id}.`
    );
  }
  const querySignal = input.signal ?? new AbortController().signal;
  const releaseQuerySlot = await acquireRepositoryQuerySlot(querySignal);
  try {
  querySignal.throwIfAborted();
  const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
  if (input.repoContext !== undefined) {
    const suppliedShas = [
      input.repoContext.base_sha,
      input.repoContext.head_sha,
      input.repoContext.merge_base,
      ...(input.repoContext.allowed_checkout_shas ?? [])
    ].filter((value): value is string => value !== undefined);
    if (!suppliedShas.every((value) => shaPattern.test(value))) {
      throw new Error("Pull request context must use full 40- or 64-character Git object ids.");
    }
    if (!shaPattern.test(index.snapshot.head_sha)) {
      throw new Error(
        `Repository snapshot ${index.snapshot.head_sha} is not a verifiable Git object id.`
      );
    }
    const allowedCheckoutShas = new Set([
      input.repoContext.head_sha,
      ...(input.repoContext.allowed_checkout_shas ?? [])
    ]);
    if (!allowedCheckoutShas.has(index.snapshot.head_sha)) {
      throw new Error(
        `Repository snapshot ${index.snapshot.head_sha} is not compatible with the supplied pull request context.`
      );
    }
  }
  const seed = seedFromInput({
    index,
    repository: input.repository,
    repoContext: input.repoContext,
    task: input.task,
    worktreeDiff: input.worktreeDiff,
    maxSeeds: Math.min(config.max_seed_files, config.max_related_files)
  });
  querySignal.throwIfAborted();
  const seedPaths = seed.seedFiles.map((file) => file.path);
  const scoring = config.enabled
    ? scoreCandidates({
      candidates: index.candidates,
      seedPaths,
      seedRelation: seed.source === "pull_request_diff" ? "changed_file" : "task_seed",
      queryTerms: seed.queryTerms,
      includeTests: config.include_tests,
      includeDocs: config.include_docs,
      includeConfigs: config.include_configs,
      importResolutionSignature: index.import_resolution_signature,
      lexicalCorpus: index.lexical_corpus,
      graphTopology: index.graph_topology
    })
    : {
      scores: new Map(),
      lexicalDiagnostics: {
        fuzzy_candidates_considered: 0,
        fuzzy_candidates_omitted: 0,
        posting_documents_considered: 0,
        posting_documents_omitted: 0,
        query_documents_omitted: 0
      },
      graphDiagnostics: {
        edges_visited: 0,
        edges_omitted: 0,
        edges_omitted_lower_bound: false,
        matches_omitted: 0,
        frontier_omitted: 0,
        score_states_omitted: 0
      }
    };
  const scores = scoring.scores;
  querySignal.throwIfAborted();
  const rankedFiles = [...scores.values()]
    .map(toRankedRelatedFile)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const selectedFiles = selectRelatedFiles(rankedFiles, new Set(seedPaths), config.max_related_files);
  const relatedFiles = selectedFiles.map((file) => {
    const score = scores.get(file.path);
    if (score === undefined) {
      throw new Error(`Selected repository context score is unavailable: ${file.path}`);
    }
    return toRelatedFile(
      score,
      config.max_excerpt_bytes,
      seed.hunkRangesByPath.get(score.path) ?? []
    );
  });
  const relatedPaths = new Set(relatedFiles.map((file) => file.path));
  const allOmittedPaths = rankedFiles.filter((file) => !relatedPaths.has(file.path)).map((file) => file.path);
  const truncatedPaths = unique([
    ...relatedFiles.flatMap((file) => file.excerpt?.truncated === true ? [file.path] : []),
    ...seed.truncatedPaths
  ]);
  const contextEdges = edgesFrom({
    files: relatedFiles,
    candidates: index.candidates,
    seedFiles: seed.seedFiles,
    graphTopology: index.graph_topology
  });
  querySignal.throwIfAborted();
  const warnings = unique([
    ...seed.warnings,
    ...index.warnings,
    ...symbolWarningsFrom(index.candidates, relatedPaths),
    ...(contextEdges.omittedEdgesCount === 0
      ? []
      : [`Repository context omitted ${contextEdges.omittedEdgesCount} edges after deterministic ranking.`]),
    ...(contextEdges.truncatedEdgeTextCount === 0
      ? []
      : [`Repository context truncated text on ${contextEdges.truncatedEdgeTextCount} edges.`])
  ]);
  const changedFiles = [...seed.changedFiles];
  const unsupportedFiles = [...seed.unsupportedFiles];
  const unseededChangedPaths = [...seed.unseededChangedPaths];

  const queryView = input.repository === undefined && input.task !== undefined;
  if (queryView) {
    querySignal.throwIfAborted();
    return {
      kind: "luna.repository_context_query.v1",
      schema_version: "1",
      source: { kind: "query" },
      snapshot: index.snapshot,
      query: input.task,
      coverage: {
        ...index.coverage,
        languages: [...index.coverage.languages],
        symbol_engines: [...index.coverage.symbol_engines]
      },
      summary: config.enabled
        ? `Repository query selected ${relatedFiles.length} files from a${index.coverage.complete ? " complete" : "n incomplete"} ${index.coverage.indexed_files}-file index.`
        : "Repository query selection is disabled; snapshot identity and coverage were still collected.",
      nodes: nodesFrom(relatedFiles),
      edges: [...contextEdges.edges],
      files: relatedFiles,
      budgets: {
        max_related_files: config.max_related_files,
        max_seed_files: config.max_seed_files,
        max_excerpt_bytes: config.max_excerpt_bytes
      },
      truncation: {
        omitted_paths: allOmittedPaths.slice(0, MAX_OMITTED_PATHS),
        omitted_count: allOmittedPaths.length,
        omitted_edges_count: contextEdges.omittedEdgesCount,
        truncated_edge_text_count: contextEdges.truncatedEdgeTextCount,
        fuzzy_candidates_considered: scoring.lexicalDiagnostics.fuzzy_candidates_considered,
        fuzzy_candidates_omitted: scoring.lexicalDiagnostics.fuzzy_candidates_omitted,
        posting_documents_considered: scoring.lexicalDiagnostics.posting_documents_considered,
        posting_documents_omitted: scoring.lexicalDiagnostics.posting_documents_omitted,
        query_documents_omitted: scoring.lexicalDiagnostics.query_documents_omitted,
        graph_edges_visited: scoring.graphDiagnostics.edges_visited,
        graph_edges_omitted: scoring.graphDiagnostics.edges_omitted,
        graph_edges_omitted_lower_bound:
          scoring.graphDiagnostics.edges_omitted_lower_bound,
        graph_matches_omitted: scoring.graphDiagnostics.matches_omitted,
        graph_frontier_omitted: scoring.graphDiagnostics.frontier_omitted,
        score_states_omitted: scoring.graphDiagnostics.score_states_omitted,
        changed_files_omitted_count: 0,
        truncated_paths: truncatedPaths.slice(0, REPOSITORY_CONTEXT_OUTPUT_LIMITS.path_diagnostics),
        truncated_paths_omitted_count: 0,
        unsupported_files: [],
        unsupported_files_omitted_count: 0,
        unseeded_changed_paths: [],
        unseeded_changed_paths_omitted_count: 0
      },
      audit: {
        enabled: config.enabled,
        scanned_files: index.coverage.indexed_files,
        skipped_files: index.coverage.eligible_files - index.coverage.indexed_files,
        max_related_files: config.max_related_files,
        max_seed_files: config.max_seed_files,
        max_excerpt_bytes: config.max_excerpt_bytes,
        languages: [...index.coverage.languages],
        symbol_engines: [...index.coverage.symbol_engines],
        warnings: warnings.slice(0, REPOSITORY_CONTEXT_OUTPUT_LIMITS.warnings),
        warnings_omitted_count: Math.max(0, warnings.length - REPOSITORY_CONTEXT_OUTPUT_LIMITS.warnings)
      }
    } satisfies RepositoryContextQuery;
  }
  if (seed.repository === undefined) {
    throw new Error("Repository identity is required for workflow repository context.");
  }
  querySignal.throwIfAborted();
  return {
    kind: "luna.repository_context.v2",
    schema_version: "2",
    source: { kind: seed.source },
    snapshot: index.snapshot,
    coverage: {
      ...index.coverage,
      languages: [...index.coverage.languages],
      symbol_engines: [...index.coverage.symbol_engines]
    },
    repository: seed.repository,
    base_sha: seed.baseSha,
    head_sha: seed.headSha,
    ...(seed.mergeBase === undefined ? {} : { merge_base: seed.mergeBase }),
    summary: config.enabled
      ? `Repository context selected ${relatedFiles.length} files from a${index.coverage.complete ? " complete" : "n incomplete"} ${index.coverage.indexed_files}-file index.`
      : "Repository context selection is disabled; snapshot identity and coverage were still collected.",
    seed_files: seedPaths,
    changed_files: changedFiles.slice(0, REPOSITORY_CONTEXT_OUTPUT_LIMITS.changed_files),
    query_terms: [...seed.queryTerms],
    nodes: nodesFrom(relatedFiles),
    edges: [...contextEdges.edges],
    files: relatedFiles,
    budgets: {
      max_related_files: config.max_related_files,
      max_seed_files: config.max_seed_files,
      max_excerpt_bytes: config.max_excerpt_bytes
    },
    truncation: {
      omitted_paths: allOmittedPaths.slice(0, MAX_OMITTED_PATHS),
      omitted_count: allOmittedPaths.length,
      omitted_edges_count: contextEdges.omittedEdgesCount,
      truncated_edge_text_count: contextEdges.truncatedEdgeTextCount,
      fuzzy_candidates_considered: scoring.lexicalDiagnostics.fuzzy_candidates_considered,
      fuzzy_candidates_omitted: scoring.lexicalDiagnostics.fuzzy_candidates_omitted,
      posting_documents_considered: scoring.lexicalDiagnostics.posting_documents_considered,
      posting_documents_omitted: scoring.lexicalDiagnostics.posting_documents_omitted,
      query_documents_omitted: scoring.lexicalDiagnostics.query_documents_omitted,
      graph_edges_visited: scoring.graphDiagnostics.edges_visited,
      graph_edges_omitted: scoring.graphDiagnostics.edges_omitted,
      graph_edges_omitted_lower_bound:
        scoring.graphDiagnostics.edges_omitted_lower_bound,
      graph_matches_omitted: scoring.graphDiagnostics.matches_omitted,
      graph_frontier_omitted: scoring.graphDiagnostics.frontier_omitted,
      score_states_omitted: scoring.graphDiagnostics.score_states_omitted,
      changed_files_omitted_count: Math.max(
        0, changedFiles.length - REPOSITORY_CONTEXT_OUTPUT_LIMITS.changed_files
      ),
      truncated_paths: truncatedPaths.slice(0, REPOSITORY_CONTEXT_OUTPUT_LIMITS.path_diagnostics),
      truncated_paths_omitted_count: Math.max(
        0, truncatedPaths.length - REPOSITORY_CONTEXT_OUTPUT_LIMITS.path_diagnostics
      ),
      unsupported_files: unsupportedFiles.slice(0, REPOSITORY_CONTEXT_OUTPUT_LIMITS.path_diagnostics),
      unsupported_files_omitted_count: Math.max(
        0, unsupportedFiles.length - REPOSITORY_CONTEXT_OUTPUT_LIMITS.path_diagnostics
      ),
      unseeded_changed_paths: unseededChangedPaths.slice(
        0, REPOSITORY_CONTEXT_OUTPUT_LIMITS.path_diagnostics
      ),
      unseeded_changed_paths_omitted_count: Math.max(
        0, unseededChangedPaths.length - REPOSITORY_CONTEXT_OUTPUT_LIMITS.path_diagnostics
      )
    },
    audit: {
      enabled: config.enabled,
      scanned_files: index.coverage.indexed_files,
      skipped_files: index.coverage.eligible_files - index.coverage.indexed_files,
      max_related_files: config.max_related_files,
      max_seed_files: config.max_seed_files,
      max_excerpt_bytes: config.max_excerpt_bytes,
      languages: [...index.coverage.languages],
      symbol_engines: [...index.coverage.symbol_engines],
      warnings: warnings.slice(0, REPOSITORY_CONTEXT_OUTPUT_LIMITS.warnings),
      warnings_omitted_count: Math.max(
        0, warnings.length - REPOSITORY_CONTEXT_OUTPUT_LIMITS.warnings
      )
    }
  };
  } finally {
    releaseQuerySlot();
  }
}

export async function collectRelatedContext(input: {
  readonly root: string;
  readonly repository: RepositoryRef;
  readonly repoContext?: RepoContext;
  readonly task?: RelatedContextTask;
  readonly worktreeDiff?: RelatedContextWorktreeDiff;
  readonly config?: RelatedContextConfig;
  readonly indexPolicy?: RepositoryContextIndexPolicy;
  readonly signal?: AbortSignal;
}): Promise<RelatedContext> {
  return await collectRelatedContextInternal(input) as RelatedContext;
}

export async function queryRepositoryContext(input: {
  readonly root: string;
  readonly task: RelatedContextTask;
  readonly config?: RelatedContextConfig;
  readonly indexPolicy?: RepositoryContextIndexPolicy;
  readonly expectedSnapshotId?: string;
  readonly signal?: AbortSignal;
}): Promise<RepositoryContextQuery> {
  return await collectRelatedContextInternal(input) as RepositoryContextQuery;
}
