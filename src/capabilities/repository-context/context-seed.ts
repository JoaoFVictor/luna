import type { RepoContext, RepositoryRef } from "../git/diff/types.js";
import { rightSideRangesFromPatch } from "../../core/repository/diff-hunks.js";
import {
  type Candidate,
  dirnameOf,
  extractSymbols,
  unique
} from "./file-analysis.js";
import { lexicalCandidateScores, lexicalTermsFrom } from "./lexical-ranking.js";
import type { LexicalCorpus } from "./lexical-ranking.js";
import type {
  RelatedContextTask,
  RelatedContextWorktreeDiff
} from "./contracts.js";
import type { RepositoryIndex } from "./repository-index.js";

export type ContextSeed = {
  readonly source: "pull_request_diff" | "task" | "worktree_diff";
  readonly repository?: RepositoryRef;
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeBase?: string;
  readonly seedFiles: readonly {
    readonly path: string;
    readonly excerpt?: { readonly content: string } | null;
  }[];
  readonly changedFiles: readonly string[];
  readonly queryTerms: readonly string[];
  readonly hunkRangesByPath: ReadonlyMap<
    string,
    ReturnType<typeof rightSideRangesFromPatch>
  >;
  readonly truncatedPaths: readonly string[];
  readonly unsupportedFiles: readonly string[];
  readonly unseededChangedPaths: readonly string[];
  readonly warnings: readonly string[];
};

function queryTermsFrom(repoContext: RepoContext): string[] {
  const terms: string[] = [];
  for (const file of repoContext.files) {
    terms.push(...lexicalTermsFrom(file.path));
    if (file.previous_path !== undefined) {
      terms.push(...lexicalTermsFrom(file.previous_path));
    }
    if (file.excerpt?.content !== undefined) {
      terms.push(...extractSymbols(file.excerpt.content, file.path).flatMap(lexicalTermsFrom));
    }
  }
  return unique(terms).slice(0, 60);
}

function taskTerms(task: RelatedContextTask | undefined, extra = ""): string[] {
  return unique([
    ...(task === undefined ? [] : lexicalTermsFrom(task.text)),
    ...(task?.symbols ?? []).flatMap(lexicalTermsFrom),
    ...(task?.paths ?? []).flatMap(lexicalTermsFrom),
    ...lexicalTermsFrom(extra)
  ]).slice(0, 60);
}

function deterministicTaskSeeds(input: {
  readonly candidates: readonly Candidate[];
  readonly explicitPaths: readonly string[];
  readonly explicitSymbols: readonly string[];
  readonly queryTerms: readonly string[];
  readonly limit: number;
  readonly lexicalCorpus: LexicalCorpus;
}): string[] {
  const explicit = new Set(input.explicitPaths);
  const lexicalScores = lexicalCandidateScores(
    input.candidates,
    input.queryTerms,
    input.lexicalCorpus
  );
  const explicitSymbolTerms = new Set(input.explicitSymbols.flatMap(lexicalTermsFrom));
  const ranked = input.candidates.map((candidate) => {
    const lexical = lexicalScores.get(candidate.path);
    const candidateSymbolTerms = new Set(candidate.symbols.flatMap(lexicalTermsFrom));
    const matchedExplicitSymbols = [...explicitSymbolTerms]
      .filter((term) => candidateSymbolTerms.has(term)).length;
    return {
      path: candidate.path,
      directory: dirnameOf(candidate.path),
      score: (explicit.has(candidate.path) ? 10_000 : 0) +
        matchedExplicitSymbols * 500 +
        (lexical?.identityScore ?? 0) * 2 +
        (lexical?.score ?? 0) * 0.2 +
        (lexical?.matchedTerms.length ?? 0) ** 2 * 100
    };
  }).filter((candidate) => candidate.score > 0);
  const bestImplicitScore = ranked.reduce((best, candidate) =>
    explicit.has(candidate.path) ? best : Math.max(best, candidate.score), 0
  );
  const eligible = ranked.filter((candidate) =>
    explicit.has(candidate.path) || candidate.score >= bestImplicitScore * 0.4
  );

  const selected: string[] = [];
  const remaining = new Map(eligible.map((candidate) => [candidate.path, candidate]));
  const directorySelections = new Map<string, number>();
  while (selected.length < input.limit && remaining.size > 0) {
    const next = [...remaining.values()].sort((left, right) => {
      const leftAdjusted = left.score / (1 + (directorySelections.get(left.directory) ?? 0) * 0.1);
      const rightAdjusted = right.score / (1 + (directorySelections.get(right.directory) ?? 0) * 0.1);
      return rightAdjusted - leftAdjusted || right.score - left.score ||
        left.path.localeCompare(right.path);
    })[0];
    if (next === undefined) {
      break;
    }
    selected.push(next.path);
    remaining.delete(next.path);
    directorySelections.set(next.directory, (directorySelections.get(next.directory) ?? 0) + 1);
  }
  return selected;
}

export function seedFromInput(input: {
  readonly index: RepositoryIndex;
  readonly repository?: RepositoryRef;
  readonly repoContext?: RepoContext;
  readonly task?: RelatedContextTask;
  readonly worktreeDiff?: RelatedContextWorktreeDiff;
  readonly maxSeeds: number;
}): ContextSeed {
  if (input.repoContext !== undefined) {
    const candidatePaths = new Set(input.index.candidates.map((candidate) => candidate.path));
    const selectedSeedPaths = input.repoContext.files
      .map((file) => file.path)
      .filter((filePath) => candidatePaths.has(filePath))
      .sort()
      .slice(0, input.maxSeeds);
    const selectedSeedPathSet = new Set(selectedSeedPaths);
    return {
      source: "pull_request_diff",
      repository: input.repoContext.repository,
      baseSha: input.repoContext.base_sha,
      headSha: input.repoContext.head_sha,
      ...(input.repoContext.merge_base === undefined ? {} : { mergeBase: input.repoContext.merge_base }),
      seedFiles: input.repoContext.files.filter((file) => selectedSeedPathSet.has(file.path)),
      changedFiles: input.repoContext.files.map((file) => file.path),
      queryTerms: queryTermsFrom(input.repoContext),
      hunkRangesByPath: new Map(input.repoContext.files.map((file) => [
        file.path,
        rightSideRangesFromPatch(file.patch)
      ])),
      truncatedPaths: input.repoContext.file_excerpts_truncated ?? [],
      unsupportedFiles: unique(input.repoContext.files.flatMap((file) =>
        file.binary === true || file.is_submodule === true ||
          file.patch_omitted_reason !== undefined || !candidatePaths.has(file.path)
          ? [file.path]
          : []
      )),
      unseededChangedPaths: input.repoContext.files
        .map((file) => file.path)
        .filter((filePath) => !selectedSeedPathSet.has(filePath)),
      warnings: input.repoContext.changed_files_truncated === true
        ? ["Diff context was truncated before repository context ranking."]
        : []
    };
  }

  const worktreePaths = input.worktreeDiff?.diff.files.map((file) => file.path) ?? [];
  const task = input.task ?? input.worktreeDiff?.task;
  const worktreeText = input.worktreeDiff === undefined
    ? ""
    : [
      input.worktreeDiff.diff.staged_diff,
      input.worktreeDiff.diff.unstaged_diff,
      ...input.worktreeDiff.diff.untracked_summaries.map((summary) => summary.excerpt.content)
    ].join("\n");
  const terms = taskTerms(task, worktreeText);
  const semanticSeedPaths = deterministicTaskSeeds({
    candidates: input.index.candidates,
    explicitPaths: task?.paths ?? [],
    explicitSymbols: task?.symbols ?? [],
    queryTerms: terms,
    limit: input.maxSeeds,
    lexicalCorpus: input.index.lexical_corpus
  });
  const candidatePaths = new Set(input.index.candidates.map((candidate) => candidate.path));
  const changedSeedPaths = unique(worktreePaths)
    .filter((filePath) => candidatePaths.has(filePath))
    .sort()
    .slice(0, input.maxSeeds);
  const effectiveSeedPaths = input.worktreeDiff === undefined
    ? semanticSeedPaths
    : unique([...changedSeedPaths, ...semanticSeedPaths]).slice(0, input.maxSeeds);
  const source = input.worktreeDiff === undefined ? "task" : "worktree_diff";
  return {
    source,
    repository: input.repository,
    baseSha: input.index.snapshot.head_sha,
    headSha: input.index.snapshot.head_sha,
    seedFiles: effectiveSeedPaths.map((filePath) => ({ path: filePath })),
    changedFiles: source === "worktree_diff" ? worktreePaths : [],
    queryTerms: terms,
    hunkRangesByPath: new Map(),
    truncatedPaths: [],
    unsupportedFiles: unique(worktreePaths.filter((filePath) => !candidatePaths.has(filePath))),
    unseededChangedPaths: input.worktreeDiff === undefined
      ? []
      : worktreePaths.filter((filePath) => !effectiveSeedPaths.includes(filePath)),
    warnings: []
  };
}
