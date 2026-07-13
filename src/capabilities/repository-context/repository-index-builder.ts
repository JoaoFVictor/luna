import { type Candidate, unique } from "./file-analysis.js";
import { importTargets, projectImportResolutionFrom } from "./import-resolution.js";
import { buildLexicalCorpus } from "./lexical-corpus.js";
import { buildGraphTopology } from "./graph-ranking.js";
import { estimateRetainedBytes } from "./retained-size-estimator.js";
import type { RepositorySnapshotIdentity } from "./repository-index-inventory.js";
import {
  repositoryIndexCapacityError,
  REPOSITORY_INDEX_RESOURCE_POLICY,
  REPOSITORY_INDEXER_VERSION
} from "./repository-index-policy.js";
import { loadRepositoryCandidates } from "./repository-index-source-loader.js";
import type { RepositoryIndex } from "./repository-index-types.js";
import {
  enrichCandidatesWithSymbolGraph,
  linkProjectSymbolReferences,
  type SymbolEngine
} from "./symbol-analysis/index.js";

function symbolEngines(candidates: readonly Candidate[]): SymbolEngine[] {
  return [...new Set(candidates.map((candidate) => candidate.symbol_graph.engine))].sort();
}

export async function buildRepositoryIndex(
  root: string,
  identity: RepositorySnapshotIdentity,
  signal?: AbortSignal
): Promise<RepositoryIndex> {
  signal?.throwIfAborted();
  const started = Date.now();
  const loaded = await loadRepositoryCandidates(root, identity, signal);
  const enriched = await enrichCandidatesWithSymbolGraph(loaded.candidates, signal);
  signal?.throwIfAborted();
  const importResolution = projectImportResolutionFrom(enriched.candidates);
  const workingBytes = estimateRetainedBytes(enriched.candidates) +
    importResolution.estimated_working_bytes;
  if (workingBytes > REPOSITORY_INDEX_RESOURCE_POLICY.max_build_working_bytes) {
    throw repositoryIndexCapacityError({
      phase: "analysis",
      resource: "working_bytes",
      observed: workingBytes,
      limit: REPOSITORY_INDEX_RESOURCE_POLICY.max_build_working_bytes
    });
  }
  const candidates = linkProjectSymbolReferences(
    enriched.candidates,
    (importValue, fromPath) => importTargets(importValue, fromPath, importResolution)
  );
  const retainedCandidateBytes = estimateRetainedBytes(candidates);
  const baseRetainedBytes = retainedCandidateBytes;
  if (baseRetainedBytes > REPOSITORY_INDEX_RESOURCE_POLICY.max_retained_index_bytes) {
    throw repositoryIndexCapacityError({
      phase: "analysis",
      resource: "retained_index_bytes",
      observed: baseRetainedBytes,
      limit: REPOSITORY_INDEX_RESOURCE_POLICY.max_retained_index_bytes
    });
  }
  const lexicalCorpus = buildLexicalCorpus(candidates, {
    retainedBytesAlready: baseRetainedBytes,
    maxRetainedBytes: REPOSITORY_INDEX_RESOURCE_POLICY.max_retained_index_bytes
  });
  const beforeTopologyBytes = baseRetainedBytes + lexicalCorpus.estimated_retained_bytes;
  const graphTopology = buildGraphTopology(candidates, importResolution, {
    retainedBytesAlready: beforeTopologyBytes,
    maxRetainedBytes: REPOSITORY_INDEX_RESOURCE_POLICY.max_retained_index_bytes
  });
  signal?.throwIfAborted();
  const languages = unique(candidates.flatMap((candidate) =>
    candidate.language === undefined ? [] : [candidate.language]
  ));
  const runtimeUnavailable = unique(loaded.unavailable);
  const binaryExcludedFiles = identity.binaryExcluded.length + loaded.binaryExcluded.length;
  const sensitiveExcludedFiles = identity.sensitiveExcluded.length + loaded.sensitiveExcluded.length;
  const eligibleFiles = identity.eligible.length - loaded.binaryExcluded.length -
    loaded.sensitiveExcluded.length;
  const complete = candidates.length === eligibleFiles && runtimeUnavailable.length === 0;

  const index: RepositoryIndex = {
    snapshot: {
      id: identity.id,
      head_sha: identity.headSha,
      dirty: identity.dirty,
      indexer_version: REPOSITORY_INDEXER_VERSION,
      policy_hash: identity.policyHash
    },
    coverage: {
      inventory_files: identity.inventory.length,
      eligible_files: eligibleFiles,
      indexed_files: candidates.length,
      excluded_files: identity.inventory.length - eligibleFiles - identity.unavailable.length,
      policy_excluded_files: identity.policyExcluded.length,
      binary_excluded_files: binaryExcludedFiles,
      sensitive_excluded_files: sensitiveExcludedFiles,
      non_regular_excluded_files: identity.nonRegularExcluded.length,
      generic_text_files: candidates.filter((candidate) => candidate.language === undefined).length,
      unavailable_files: identity.unavailable.length + runtimeUnavailable.length,
      complete,
      languages,
      symbol_engines: symbolEngines(candidates)
    },
    candidates,
    import_resolution_signature: importResolution.signature,
    lexical_corpus: lexicalCorpus,
    graph_topology: graphTopology,
    warnings: [
      ...enriched.warnings,
      ...importResolution.warnings,
      ...(complete
        ? []
        : [`Repository index is incomplete: ${runtimeUnavailable.length} eligible files became unavailable during indexing.`])
    ],
    stats: {
      inventory_path_bytes: identity.inventoryPathBytes,
      planned_source_bytes: loaded.plannedSourceBytes,
      indexed_source_bytes: loaded.indexedSourceBytes,
      retained_index_bytes: 0,
      retained_candidate_bytes: retainedCandidateBytes,
      retained_derived_bytes: 0,
      peak_inflight_source_bytes: loaded.peakInflightBytes,
      read_concurrency: loaded.concurrency,
      preflight_duration_ms: loaded.preflightDurationMs,
      build_duration_ms: Date.now() - started,
      limits: REPOSITORY_INDEX_RESOURCE_POLICY
    }
  };
  const retainedBytes = estimateRetainedBytes(index);
  if (retainedBytes > REPOSITORY_INDEX_RESOURCE_POLICY.max_retained_index_bytes) {
    throw repositoryIndexCapacityError({
      phase: "analysis",
      resource: "retained_index_bytes",
      observed: retainedBytes,
      limit: REPOSITORY_INDEX_RESOURCE_POLICY.max_retained_index_bytes
    });
  }
  return {
    ...index,
    stats: {
      ...index.stats,
      retained_index_bytes: retainedBytes,
      retained_derived_bytes: Math.max(0, retainedBytes - retainedCandidateBytes)
    }
  };
}
