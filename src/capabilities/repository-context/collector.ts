import path from "node:path";
import type { RepoContext } from "../git/diff/types.js";
import {
  basenameStem,
  type Candidate,
  dirnameOf,
  extractSymbols,
  importEdgeType,
  importTargets,
  isSupportedFile,
  isTestPath,
  type ProjectImportResolution,
  projectImportResolutionFrom,
  readCandidate,
  unique,
  walkFiles,
  wordsFrom
} from "./file-analysis.js";
import { rightSideRangesFromPatch } from "../../core/repository/diff-hunks.js";
import {
  enrichCandidatesWithSymbolGraph,
  linkProjectSymbolReferences,
  reverseReferenceDefinitionSymbolsFromGraph,
  type SymbolEngine
} from "./symbol-analysis/index.js";
import {
  primaryReasonForRelation,
  scoreCandidates,
  selectRelatedFiles,
  sourceFrom,
  toRelatedFile
} from "./ranking.js";
import type {
  RelatedContext,
  RelatedContextEdge,
  RelatedContextConfig,
  RelatedContextFile,
  RelatedContextNode
} from "./contracts.js";

const DEFAULT_MAX_RELATED_FILES = 12;
const DEFAULT_MAX_SCAN_FILES = 600;
const DEFAULT_MAX_FILE_BYTES = 160_000;
const DEFAULT_MAX_EXCERPT_BYTES = 4_000;
const READ_CANDIDATE_CONCURRENCY = 32;
const MAX_OMITTED_PATHS = 50;

function resolveRelatedContextConfig(
  config: RelatedContextConfig | undefined
): Required<RelatedContextConfig> {
  const resolved = config ?? {};

  return {
    enabled: resolved.enabled ?? true,
    max_related_files: resolved.max_related_files ?? DEFAULT_MAX_RELATED_FILES,
    max_scan_files: resolved.max_scan_files ?? DEFAULT_MAX_SCAN_FILES,
    max_file_bytes: resolved.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES,
    max_excerpt_bytes: resolved.max_excerpt_bytes ?? DEFAULT_MAX_EXCERPT_BYTES,
    include_tests: resolved.include_tests ?? true,
    include_docs: resolved.include_docs ?? true,
    include_configs: resolved.include_configs ?? true
  };
}

function queryTermsFrom(repoContext: RepoContext): string[] {
  const terms: string[] = [];

  for (const file of repoContext.files) {
    terms.push(...wordsFrom(file.path));
    if (file.previous_path !== undefined) {
      terms.push(...wordsFrom(file.previous_path));
    }
    if (file.excerpt?.content !== undefined) {
      terms.push(...extractSymbols(file.excerpt.content, file.path));
    }
  }

  return unique(terms).slice(0, 60);
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

function edgesFrom(input: {
  readonly files: readonly RelatedContextFile[];
  readonly candidates: readonly Candidate[];
  readonly repoContext: RepoContext;
  readonly importResolution: ProjectImportResolution;
}): RelatedContextEdge[] {
  const edges: RelatedContextEdge[] = [];
  const candidateByPath = new Map(input.candidates.map((candidate) => [candidate.path, candidate]));
  const reverseReferenceDefinitionsByPath = new Map(input.candidates.map((candidate) => [
    candidate.path,
    reverseReferenceDefinitionSymbolsFromGraph(candidate.symbol_graph)
  ]));
  const changedPaths = new Set(input.repoContext.files.map((file) => file.path));
  const changedStems = new Set(input.repoContext.files.map((file) => basenameStem(file.path)));
  const relatedPaths = new Set(input.files.map((file) => file.path));

  function addEdge(edge: RelatedContextEdge): void {
    const key = `${edge.from}\0${edge.to}\0${edge.type}`;
    if (!edges.some((existing) => `${existing.from}\0${existing.to}\0${existing.type}` === key)) {
      edges.push(edge);
    }
  }

  function seedMatchesContextFile(seed: RepoContext["files"][number], file: RelatedContextFile): boolean {
    const seedTerms = unique([
      ...wordsFrom(seed.path),
      basenameStem(seed.path),
      ...(seed.excerpt?.content === undefined ? [] : extractSymbols(seed.excerpt.content, seed.path))
    ]);
    return seedTerms.some((term) =>
      file.matched_terms.includes(term) ||
      file.matched_symbols.includes(term) ||
      includesToken(file.excerpt?.content ?? "", term)
    );
  }

  for (const seed of input.candidates.filter((candidate) => changedPaths.has(candidate.path))) {
    for (const importValue of seed.imports) {
      for (const target of importTargets(importValue, seed.path, input.importResolution)) {
        if (relatedPaths.has(target)) {
          addEdge({
            from: seed.path,
            to: target,
            type: importEdgeType(importValue),
            reason: `Changed file imports/includes ${importValue}.`
          });
        }
      }
    }
  }

  for (const file of input.files) {
    if (changedPaths.has(file.path)) {
      continue;
    }

    const candidate = candidateByPath.get(file.path);
    if (candidate === undefined) {
      continue;
    }

    for (const importValue of candidate.imports) {
      const matchedChangedPath = importTargets(
        importValue,
        candidate.path,
        input.importResolution
      )
        .find((target) => changedPaths.has(target) && relatedPaths.has(target));
      if (matchedChangedPath !== undefined) {
        addEdge({
          from: candidate.path,
          to: matchedChangedPath,
          type: importEdgeType(importValue),
          reason: `Related file imports/includes changed code through ${importValue}.`
        });
      }
    }

    if (file.relation === "same_directory") {
      const sameDirSeed = input.repoContext.files
        .find((seed) => dirnameOf(seed.path) === dirnameOf(file.path));
      if (sameDirSeed !== undefined) {
        addEdge({
          from: sameDirSeed.path,
          to: file.path,
          type: "nearby",
          reason: "Files share the same directory."
        });
      }
    }

    if (isTestPath(file.path)) {
      const matchedStem = [...changedStems]
        .find((stem) => file.path.toLowerCase().includes(stem.toLowerCase()));
      const testedFile = input.repoContext.files
        .find((seed) => basenameStem(seed.path) === matchedStem);
      if (testedFile !== undefined) {
        addEdge({
          from: file.path,
          to: testedFile.path,
          type: "tests",
          reason: "Test/spec path matches changed file name."
        });
      }
    }

    if (file.relation === "config") {
      for (const seed of input.repoContext.files) {
        if (!seedMatchesContextFile(seed, file)) {
          continue;
        }
        addEdge({
          from: file.path,
          to: seed.path,
          type: "configured_by",
          reason: "Config file may affect changed code."
        });
      }
    }

    if (file.relation === "docs") {
      for (const seed of input.repoContext.files) {
        if (!seedMatchesContextFile(seed, file)) {
          continue;
        }
        addEdge({
          from: file.path,
          to: seed.path,
          type: "documents",
          reason: "Documentation mentions changed concepts."
        });
      }
    }

    if (file.relation === "similar_abstraction") {
      const similarSeed = input.repoContext.files
        .find((seed) => basenameStem(seed.path) === basenameStem(file.path));
      if (similarSeed !== undefined) {
        addEdge({
          from: file.path,
          to: similarSeed.path,
          type: "similar_to",
          reason: "Files share the same abstraction name."
        });
      }
    }

    if (file.relation === "reverse_reference") {
      const referencedSeed = input.repoContext.files
        .find((seed) => {
          if (!relatedPaths.has(seed.path)) {
            return false;
          }
          const seedSymbols = reverseReferenceDefinitionsByPath.get(seed.path) ?? [];
          return file.matched_symbols.some((symbol) => seedSymbols.includes(symbol));
        });
      if (referencedSeed !== undefined) {
        addEdge({
          from: file.path,
          to: referencedSeed.path,
          type: "references",
          reason: "Related file references a changed symbol."
        });
      }
    }
  }

  return edges.sort((left, right) =>
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.type.localeCompare(right.type)
  );
}

function includesToken(content: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emptyContext(repoContext: RepoContext, config: Required<RelatedContextConfig>): RelatedContext {
  const budgets = {
    max_related_files: config.max_related_files,
    max_scan_files: config.max_scan_files,
    max_file_bytes: config.max_file_bytes,
    max_excerpt_bytes: config.max_excerpt_bytes
  };

  return {
    kind: "luna.related_context.v1",
    schema_version: "1",
    repository: repoContext.repository,
    base_sha: repoContext.base_sha,
    head_sha: repoContext.head_sha,
    ...(repoContext.merge_base === undefined ? {} : { merge_base: repoContext.merge_base }),
    summary: "Related repository context collection is disabled.",
    seed_files: repoContext.files.map((file) => file.path),
    changed_files: repoContext.files.map((file) => file.path),
    query_terms: [],
    nodes: [],
    edges: [],
    files: [],
    budgets,
    truncation: {
      omitted_paths: [],
      omitted_count: 0,
      truncated_paths: [],
      unsupported_files: []
    },
    audit: {
      enabled: false,
      scanned_files: 0,
      skipped_files: 0,
      max_related_files: config.max_related_files,
      max_scan_files: config.max_scan_files,
      max_file_bytes: config.max_file_bytes,
      max_excerpt_bytes: config.max_excerpt_bytes,
      languages: [],
      symbol_engines: [],
      warnings: []
    }
  };
}

function symbolEnginesFrom(candidates: readonly Candidate[]): SymbolEngine[] {
  return [...new Set(candidates.map((candidate) => candidate.symbol_graph.engine))]
    .sort();
}

function symbolWarningsFrom(
  candidates: readonly Candidate[],
  selectedPaths: ReadonlySet<string>
): string[] {
  return unique(candidates.filter((candidate) => selectedPaths.has(candidate.path)).flatMap((candidate) =>
    candidate.symbol_graph.warnings.map((warning) => `${candidate.path}: ${warning}`)
  )).slice(0, 40);
}

async function readCandidates(
  root: string,
  files: readonly string[],
  maxFileBytes: number
): Promise<Candidate[]> {
  const uniqueFiles = unique(files);
  const candidates: Candidate[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < uniqueFiles.length) {
      const file = uniqueFiles[nextIndex] as string;
      nextIndex += 1;
      const candidate = await readCandidate(root, file, maxFileBytes);
      if (candidate !== undefined) {
        candidates.push(candidate);
      }
    }
  }

  const workers = Array.from({
    length: Math.min(READ_CANDIDATE_CONCURRENCY, uniqueFiles.length)
  }, () => worker());
  await Promise.all(workers);
  return candidates.sort((left, right) => left.path.localeCompare(right.path));
}

function directImportTargets(input: {
  readonly candidates: readonly Candidate[];
  readonly changedPaths: ReadonlySet<string>;
  readonly importResolution: ProjectImportResolution;
}): string[] {
  const candidatePaths = new Set(input.candidates.map((candidate) => candidate.path));
  const targets = input.candidates
    .filter((candidate) => input.changedPaths.has(candidate.path))
    .flatMap((candidate) =>
      candidate.imports.flatMap((importValue) =>
        importTargets(importValue, candidate.path, input.importResolution)
      )
    )
    .filter((target) => !candidatePaths.has(target) && isSupportedFile(target));

  return unique(targets);
}

export async function collectRelatedContext({
  root,
  repoContext,
  config: rawConfig
}: {
  readonly root: string;
  readonly repoContext: RepoContext;
  readonly config?: RelatedContextConfig;
}): Promise<RelatedContext> {
  const config = resolveRelatedContextConfig(rawConfig);
  const repositoryRoot = path.resolve(root);

  if (!config.enabled) {
    return emptyContext(repoContext, config);
  }

  const { files, skipped } = await walkFiles(repositoryRoot, {
    maxScanFiles: config.max_scan_files
  });
  const changedPaths = repoContext.files.map((file) => file.path);
  const initialCandidates = await readCandidates(
    repositoryRoot,
    unique([...files, ...changedPaths.filter(isSupportedFile)]),
    config.max_file_bytes
  );
  const firstPass = await enrichCandidatesWithSymbolGraph(repositoryRoot, initialCandidates);
  const firstImportResolution = projectImportResolutionFrom(firstPass.candidates);
  const directImportPaths = directImportTargets({
    candidates: firstPass.candidates,
    changedPaths: new Set(changedPaths),
    importResolution: firstImportResolution
  });
  const firstCandidatePaths = new Set(firstPass.candidates.map((candidate) => candidate.path));
  const extraCandidates = await readCandidates(
    repositoryRoot,
    directImportPaths.filter((file) => !firstCandidatePaths.has(file)),
    config.max_file_bytes
  );
  const extraPass = await enrichCandidatesWithSymbolGraph(repositoryRoot, extraCandidates);
  const candidates = [
    ...firstPass.candidates,
    ...extraPass.candidates
  ];
  const symbolGraphWarnings = [...firstPass.warnings, ...extraPass.warnings];
  const queryTerms = queryTermsFrom(repoContext);
  const importResolution = projectImportResolutionFrom(candidates);
  const linkedCandidates = linkProjectSymbolReferences(
    candidates,
    (importValue, fromPath) => importTargets(importValue, fromPath, importResolution)
  );
  const scores = scoreCandidates({
    candidates: linkedCandidates,
    repoContext,
    queryTerms,
    includeTests: config.include_tests,
    includeDocs: config.include_docs,
    includeConfigs: config.include_configs,
    importResolution
  });
  const hunkRangesByPath = new Map(repoContext.files.map((file) => [
    file.path,
    rightSideRangesFromPatch(file.patch)
  ]));
  const rankedFiles = [...scores.values()]
    .map((score) => toRelatedFile(
      score,
      config.max_excerpt_bytes,
      hunkRangesByPath.get(score.path) ?? []
    ))
    .sort((left, right) =>
      right.score - left.score || left.path.localeCompare(right.path)
    );
  const relatedFiles = selectRelatedFiles(
    rankedFiles,
    new Set(changedPaths),
    config.max_related_files
  );
  const relatedPaths = new Set(relatedFiles.map((file) => file.path));
  const allOmittedPaths = rankedFiles
    .filter((file) => !relatedPaths.has(file.path))
    .map((file) => file.path);
  const omittedPaths = allOmittedPaths.slice(0, MAX_OMITTED_PATHS);
  const nodes = nodesFrom(relatedFiles);
  const edges = edgesFrom({
    files: relatedFiles,
    candidates: linkedCandidates,
    repoContext,
    importResolution
  });
  const languages = unique(relatedFiles.flatMap((file) =>
    file.language === undefined ? [] : [file.language]
  ));
  const truncatedPaths = unique([
    ...relatedFiles.flatMap((file) =>
      file.excerpt?.truncated === true ? [file.path] : []
    ),
    ...(repoContext.file_excerpts_truncated ?? [])
  ]);
  const unsupportedFiles = unique(repoContext.files.flatMap((file) =>
    file.binary === true ||
    file.is_submodule === true ||
    file.patch_omitted_reason !== undefined ||
    !isSupportedFile(file.path)
      ? [file.path]
      : []
  ));
  const budgets = {
    max_related_files: config.max_related_files,
    max_scan_files: config.max_scan_files,
    max_file_bytes: config.max_file_bytes,
    max_excerpt_bytes: config.max_excerpt_bytes
  };
  const warnings = [
    ...(repoContext.changed_files_truncated === true
      ? ["Diff context was truncated before related context ranking."]
      : []),
    ...(skipped > 0
      ? [`Repository scan skipped ${skipped} supported files after max_scan_files.`]
      : []),
    ...symbolGraphWarnings,
    ...symbolWarningsFrom(linkedCandidates, new Set(relatedFiles.map((file) => file.path)))
  ];

  return {
    kind: "luna.related_context.v1",
    schema_version: "1",
    repository: repoContext.repository,
    base_sha: repoContext.base_sha,
    head_sha: repoContext.head_sha,
    ...(repoContext.merge_base === undefined ? {} : { merge_base: repoContext.merge_base }),
    summary: `Related repository context selected ${relatedFiles.length} files from ${linkedCandidates.length} scanned files.`,
    seed_files: changedPaths,
    changed_files: changedPaths,
    query_terms: queryTerms,
    nodes,
    edges,
    files: relatedFiles,
    budgets,
    truncation: {
      omitted_paths: omittedPaths,
      omitted_count: allOmittedPaths.length,
      truncated_paths: truncatedPaths,
      unsupported_files: unsupportedFiles
    },
    audit: {
      enabled: true,
      scanned_files: linkedCandidates.length,
      skipped_files: skipped,
      max_related_files: config.max_related_files,
      max_scan_files: config.max_scan_files,
      max_file_bytes: config.max_file_bytes,
      max_excerpt_bytes: config.max_excerpt_bytes,
      languages,
      symbol_engines: symbolEnginesFrom(linkedCandidates),
      warnings
    }
  };
}
