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
import {
  excerptFrom,
  type FocusRange
} from "./excerpts.js";
import { rightSideRangesFromPatch } from "../../core/repository/diff-hunks.js";
import {
  enrichCandidatesWithAst,
  type SymbolEngine
} from "./symbol-analysis/index.js";
import type {
  RelatedContext,
  RelatedContextEdge,
  RelatedContextConfig,
  RelatedContextFile,
  RelatedContextNode,
  RelatedContextRelation
} from "./contracts.js";

type ScoreState = {
  readonly path: string;
  readonly language?: string;
  readonly kind: Candidate["kind"];
  readonly content: string;
  readonly truncated: boolean;
  readonly score_breakdown: Record<string, number>;
  readonly matched_terms: Set<string>;
  readonly matched_symbols: Set<string>;
  readonly reasons: Set<string>;
};

const DEFAULT_MAX_RELATED_FILES = 12;
const DEFAULT_MAX_SCAN_FILES = 600;
const DEFAULT_MAX_FILE_BYTES = 24_000;
const DEFAULT_MAX_EXCERPT_BYTES = 4_000;
const IMPORT_SCORE = 85;
const REVERSE_REFERENCE_SCORE = 70;
const TEST_SCORE = 60;
const SAME_DIRECTORY_SCORE = 28;
const CONFIG_SCORE = 24;
const DOCS_SCORE = 16;
const SIMILAR_ABSTRACTION_SCORE = 12;
const CHANGED_FILE_SCORE = 100;
const RESERVED_RELATIONS: readonly RelatedContextRelation[] = [
  "import_dependency",
  "reverse_reference",
  "test",
  "similar_abstraction"
];

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

function addScore(
  scores: Map<string, ScoreState>,
  candidate: Candidate,
  key: string,
  amount: number,
  reason: string,
  terms: readonly string[] = [],
  symbols: readonly string[] = []
): void {
  const current = scores.get(candidate.path) ?? {
    path: candidate.path,
    language: candidate.language,
    kind: candidate.kind,
    content: candidate.content,
    truncated: candidate.truncated,
    score_breakdown: {},
    matched_terms: new Set<string>(),
    matched_symbols: new Set<string>(),
    reasons: new Set<string>()
  };

  current.score_breakdown[key] = Math.max(current.score_breakdown[key] ?? 0, amount);
  current.reasons.add(reason);
  for (const term of terms) {
    current.matched_terms.add(term);
  }
  for (const symbol of symbols) {
    current.matched_symbols.add(symbol);
  }
  scores.set(candidate.path, current);
}

function relationFrom(scoreBreakdown: Record<string, number>): RelatedContextRelation {
  const ordered: readonly [RelatedContextRelation, string][] = [
    ["changed_file", "changed_file"],
    ["test", "test"],
    ["config", "config"],
    ["docs", "docs"],
    ["import_dependency", "import_dependency"],
    ["reverse_reference", "reverse_reference"],
    ["same_directory", "same_directory"],
    ["similar_abstraction", "similar_abstraction"]
  ];

  for (const [relation, key] of ordered) {
    if (scoreBreakdown[key] !== undefined) {
      return relation;
    }
  }

  return "same_directory";
}

function primaryReasonForRelation(file: RelatedContextFile): string {
  const byRelation: Record<RelatedContextRelation, readonly string[]> = {
    changed_file: ["File is changed by the pull request."],
    import_dependency: ["Changed file imports/includes this file."],
    reverse_reference: [
      "File imports/includes changed code.",
      "File references changed symbols."
    ],
    test: ["Test/spec path matches changed code."],
    same_directory: ["File is near a changed file."],
    config: ["Repository config can affect changed code review."],
    docs: ["Documentation mentions changed concepts."],
    similar_abstraction: ["File has the same abstraction name as changed code."]
  };
  const preferred = byRelation[file.relation]
    .find((reason) => file.reasons.includes(reason));

  return preferred ?? file.reasons[0] ?? "Selected by repository context ranking.";
}

function toRelatedFile(
  score: ScoreState,
  maxExcerptBytes: number,
  focusRanges: readonly FocusRange[] = []
): RelatedContextFile {
  const totalScore = Object.values(score.score_breakdown)
    .reduce((total, value) => total + value, 0);

  return {
    path: score.path,
    relation: relationFrom(score.score_breakdown),
    ...(score.language === undefined ? {} : { language: score.language }),
    score: totalScore,
    score_breakdown: score.score_breakdown,
    excerpt: excerptFrom(score.content, maxExcerptBytes, score.truncated, focusRanges),
    matched_terms: [...score.matched_terms].sort(),
    matched_symbols: [...score.matched_symbols].sort(),
    reasons: [...score.reasons].sort()
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

function sourceFrom(relation: RelatedContextRelation): string {
  switch (relation) {
    case "changed_file":
      return "diff";
    case "import_dependency":
      return "import_scan";
    case "reverse_reference":
      return "reverse_scan";
    case "test":
      return "test_mapping";
    case "same_directory":
      return "path_scan";
    case "config":
      return "config_mapping";
    case "docs":
      return "doc_mapping";
    case "similar_abstraction":
      return "similarity_scan";
  }
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
        .find((target) => changedPaths.has(target));
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
        .find((seed) => file.matched_symbols.some((symbol) =>
          seed.excerpt?.content.includes(symbol) === true
        ));
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

function scoreCandidates(input: {
  readonly candidates: readonly Candidate[];
  readonly repoContext: RepoContext;
  readonly queryTerms: readonly string[];
  readonly includeTests: boolean;
  readonly includeDocs: boolean;
  readonly includeConfigs: boolean;
  readonly importResolution: ProjectImportResolution;
}): Map<string, ScoreState> {
  const scores = new Map<string, ScoreState>();
  const candidateByPath = new Map(input.candidates.map((candidate) => [candidate.path, candidate]));
  const changedPaths = new Set(input.repoContext.files.map((file) => file.path));
  const seedDirs = new Set(input.repoContext.files.map((file) => dirnameOf(file.path)));
  const seedStems = new Set(input.repoContext.files.map((file) => basenameStem(file.path)));
  const seedSymbols = unique([
    ...input.candidates
      .filter((candidate) => changedPaths.has(candidate.path))
      .flatMap((candidate) => candidate.symbols),
    ...input.repoContext.files.flatMap((file) =>
      file.excerpt?.content === undefined ? [] : extractSymbols(file.excerpt.content, file.path)
    )
  ]);

  for (const candidate of input.candidates) {
    if (changedPaths.has(candidate.path)) {
      addScore(scores, candidate, "changed_file", CHANGED_FILE_SCORE, "File is changed by the pull request.");
    }

    if (seedDirs.has(dirnameOf(candidate.path)) && !changedPaths.has(candidate.path)) {
      addScore(scores, candidate, "same_directory", SAME_DIRECTORY_SCORE, "File is near a changed file.");
    }

    if (input.includeTests && candidate.kind === "test") {
      const matched = [...seedStems].filter((stem) => candidate.path.toLowerCase().includes(stem.toLowerCase()));
      if (matched.length > 0) {
        addScore(scores, candidate, "test", TEST_SCORE, "Test/spec path matches changed code.", matched);
      }
    }

    if (input.includeConfigs && candidate.kind === "config") {
      addScore(scores, candidate, "config", CONFIG_SCORE, "Repository config can affect changed code review.");
    }

    if (input.includeDocs && candidate.kind === "docs") {
      const matched = input.queryTerms.filter((term) => includesToken(candidate.content, term)).slice(0, 8);
      if (matched.length > 0) {
        addScore(scores, candidate, "docs", DOCS_SCORE, "Documentation mentions changed concepts.", matched);
      }
    }

    const canReferenceChangedCode = candidate.kind === "source" || candidate.kind === "test";
    const matchedSymbols = canReferenceChangedCode
      ? seedSymbols.filter((symbol) => includesToken(candidate.content, symbol)).slice(0, 12)
      : [];
    if (!changedPaths.has(candidate.path) && matchedSymbols.length > 0) {
      addScore(scores, candidate, "reverse_reference", REVERSE_REFERENCE_SCORE, "File references changed symbols.", [], matchedSymbols);
    }

    const sameStem = [...seedStems].filter((stem) => basenameStem(candidate.path).toLowerCase() === stem.toLowerCase());
    if (!changedPaths.has(candidate.path) && canReferenceChangedCode && sameStem.length > 0) {
      addScore(scores, candidate, "similar_abstraction", SIMILAR_ABSTRACTION_SCORE, "File has the same abstraction name as changed code.", sameStem);
    }
  }

  for (const seed of input.candidates.filter((candidate) => changedPaths.has(candidate.path))) {
    for (const importValue of seed.imports) {
      for (const target of importTargets(importValue, seed.path, input.importResolution)) {
        const candidate = candidateByPath.get(target);
        if (candidate !== undefined) {
          addScore(scores, candidate, "import_dependency", IMPORT_SCORE, "Changed file imports/includes this file.", [importValue]);
        }
      }
    }
  }

  for (const candidate of input.candidates) {
    if (changedPaths.has(candidate.path) || (candidate.kind !== "source" && candidate.kind !== "test")) {
      continue;
    }

    for (const importValue of candidate.imports) {
      const targets = importTargets(
        importValue,
        candidate.path,
        input.importResolution
      );
      const matchedChangedPath = targets.find((target) => changedPaths.has(target));
      if (matchedChangedPath !== undefined) {
        addScore(scores, candidate, "reverse_reference", REVERSE_REFERENCE_SCORE, "File imports/includes changed code.", [importValue]);
      }
    }
  }

  return scores;
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
  return [...new Set(candidates.map((candidate) => candidate.symbol_analysis.engine))]
    .sort();
}

function symbolWarningsFrom(
  candidates: readonly Candidate[],
  selectedPaths: ReadonlySet<string>
): string[] {
  return unique(candidates.filter((candidate) => selectedPaths.has(candidate.path)).flatMap((candidate) =>
    candidate.symbol_analysis.warnings.map((warning) => `${candidate.path}: ${warning}`)
  )).slice(0, 40);
}

async function readCandidates(
  root: string,
  files: readonly string[],
  maxFileBytes: number
): Promise<Candidate[]> {
  return (await Promise.all(
    unique(files).map((file) => readCandidate(root, file, maxFileBytes))
  )).filter((candidate): candidate is Candidate => candidate !== undefined);
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

function selectRelatedFiles(
  rankedFiles: readonly RelatedContextFile[],
  changedPaths: ReadonlySet<string>,
  maxFiles: number
): RelatedContextFile[] {
  const selected: RelatedContextFile[] = [];
  const selectedPaths = new Set<string>();
  function add(file: RelatedContextFile): void {
    if (selected.length >= maxFiles || selectedPaths.has(file.path)) {
      return;
    }
    selected.push(file);
    selectedPaths.add(file.path);
  }

  for (const file of rankedFiles.filter((rankedFile) => changedPaths.has(rankedFile.path))) {
    add(file);
  }

  const remaining = rankedFiles.filter((file) => !changedPaths.has(file.path));
  for (const relation of RESERVED_RELATIONS) {
    const best = remaining.find((file) => file.relation === relation);
    if (best !== undefined) {
      add(best);
    }
  }

  for (const file of remaining) {
    add(file);
  }

  return selected;
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
  const firstPass = await enrichCandidatesWithAst(repositoryRoot, initialCandidates);
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
  const extraPass = await enrichCandidatesWithAst(repositoryRoot, extraCandidates);
  const candidates = [
    ...firstPass.candidates,
    ...extraPass.candidates
  ];
  const astWarnings = [...firstPass.warnings, ...extraPass.warnings];
  const queryTerms = queryTermsFrom(repoContext);
  const importResolution = projectImportResolutionFrom(candidates);
  const scores = scoreCandidates({
    candidates,
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
  const nodes = nodesFrom(relatedFiles);
  const edges = edgesFrom({
    files: relatedFiles,
    candidates,
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
    ...astWarnings,
    ...symbolWarningsFrom(candidates, new Set(relatedFiles.map((file) => file.path)))
  ];

  return {
    kind: "luna.related_context.v1",
    schema_version: "1",
    repository: repoContext.repository,
    base_sha: repoContext.base_sha,
    head_sha: repoContext.head_sha,
    ...(repoContext.merge_base === undefined ? {} : { merge_base: repoContext.merge_base }),
    summary: `Related repository context selected ${relatedFiles.length} files from ${candidates.length} scanned files.`,
    seed_files: changedPaths,
    changed_files: changedPaths,
    query_terms: queryTerms,
    nodes,
    edges,
    files: relatedFiles,
    budgets,
    truncation: {
      omitted_paths: [],
      truncated_paths: truncatedPaths,
      unsupported_files: unsupportedFiles
    },
    audit: {
      enabled: true,
      scanned_files: candidates.length,
      skipped_files: skipped,
      max_related_files: config.max_related_files,
      max_scan_files: config.max_scan_files,
      max_file_bytes: config.max_file_bytes,
      max_excerpt_bytes: config.max_excerpt_bytes,
      languages,
      symbol_engines: symbolEnginesFrom(candidates),
      warnings
    }
  };
}
