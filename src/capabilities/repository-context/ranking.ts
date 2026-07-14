import {
  basenameStem,
  type Candidate,
  dirnameOf
} from "./file-analysis.js";
import {
  excerptFrom,
  type FocusRange
} from "./excerpts.js";
import {
  graphRankingMatchesDetailed,
  type GraphQueryDiagnostics,
  type GraphTopology
} from "./graph-ranking.js";
import {
  relationFrom,
  relationScore
} from "./relation-policies.js";
export {
  primaryReasonForRelation,
  sourceFrom
} from "./relation-policies.js";
export { selectRelatedFiles } from "./context-selection.js";
import type { RelatedContextFile } from "./contracts.js";
export {
  lexicalCandidateScores,
  lexicalTermsFrom
} from "./lexical-ranking.js";
import {
  lexicalCandidateScoresDetailed,
  type LexicalCorpus,
  type LexicalQueryDiagnostics
} from "./lexical-ranking.js";

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
  graphDepth?: number;
  graphSeedRank?: number;
};
const MAX_QUERY_SCORE_STATES = 10_000;

export type RankedRelatedContextFile = RelatedContextFile & {
  readonly graphDepth?: number;
  readonly graphSeedRank?: number;
};

function addScore(
  scores: Map<string, ScoreState>,
  candidate: Candidate,
  key: string,
  amount: number,
  reason: string,
  terms: readonly string[] = [],
  symbols: readonly string[] = []
): boolean {
  const existing = scores.get(candidate.path);
  if (existing === undefined && scores.size >= MAX_QUERY_SCORE_STATES) {
    return false;
  }
  const current = existing ?? {
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
  return true;
}

export function toRelatedFile(
  score: ScoreState,
  maxExcerptBytes: number,
  focusRanges: readonly FocusRange[] = []
): RelatedContextFile {
  return relatedFileFromScore(
    score,
    excerptFrom(score.content, maxExcerptBytes, score.truncated, focusRanges)
  );
}

export function toRankedRelatedFile(score: ScoreState): RankedRelatedContextFile {
  return {
    ...relatedFileFromScore(score, null),
    ...(score.graphDepth === undefined ? {} : { graphDepth: score.graphDepth }),
    ...(score.graphSeedRank === undefined ? {} : { graphSeedRank: score.graphSeedRank })
  };
}

function relatedFileFromScore(
  score: ScoreState,
  excerpt: RelatedContextFile["excerpt"]
): RelatedContextFile {
  const totalScore = Object.values(score.score_breakdown)
    .reduce((total, value) => total + value, 0);

  return {
    path: score.path,
    relation: relationFrom(score.score_breakdown),
    ...(score.language === undefined ? {} : { language: score.language }),
    score: totalScore,
    score_breakdown: score.score_breakdown,
    excerpt,
    matched_terms: [...score.matched_terms].sort(),
    matched_symbols: [...score.matched_symbols].sort(),
    reasons: [...score.reasons].sort()
  };
}

export function scoreCandidates(input: {
  readonly candidates: readonly Candidate[];
  readonly seedPaths: readonly string[];
  readonly seedRelation: "changed_file" | "task_seed";
  readonly queryTerms: readonly string[];
  readonly includeTests: boolean;
  readonly includeDocs: boolean;
  readonly includeConfigs: boolean;
  readonly importResolutionSignature: string;
  readonly lexicalCorpus: LexicalCorpus;
  readonly graphTopology: GraphTopology;
}): {
  readonly scores: Map<string, ScoreState>;
  readonly lexicalDiagnostics: LexicalQueryDiagnostics;
  readonly graphDiagnostics: GraphQueryDiagnostics & { readonly score_states_omitted: number };
} {
  const scores = new Map<string, ScoreState>();
  const omittedScorePaths = new Set<string>();
  const addCandidateScore = (
    candidate: Candidate,
    key: string,
    amount: number,
    reason: string,
    terms: readonly string[] = [],
    symbols: readonly string[] = []
  ): void => {
    if (!addScore(scores, candidate, key, amount, reason, terms, symbols)) {
      omittedScorePaths.add(candidate.path);
    }
  };
  const seedPaths = new Set(input.seedPaths);
  const seedDirs = new Set(input.seedPaths
    .map(dirnameOf)
    .filter((directory) => directory !== ""));
  const seedStems = new Set(input.seedPaths.map(basenameStem));
  const lexicalResult = lexicalCandidateScoresDetailed(
    input.candidates,
    input.queryTerms,
    input.lexicalCorpus
  );
  const lexicalScores = lexicalResult.scores;

  for (const seedPath of input.seedPaths) {
    const seedCandidate = input.graphTopology.candidateByPath.get(seedPath);
    if (seedCandidate !== undefined) {
      addCandidateScore(
        seedCandidate,
        input.seedRelation,
        relationScore(input.seedRelation),
        input.seedRelation === "changed_file"
          ? "File is changed by the pull request."
          : "File is a deterministic task seed."
      );
    }
  }

  for (const candidate of input.candidates) {
    const lexical = lexicalScores.get(candidate.path);
    if (lexical !== undefined) {
      addCandidateScore(
        candidate,
        "query_match",
        lexical.score,
        "File matches task or change query terms.",
        lexical.matchedTerms,
        lexical.matchedSymbols
      );
    }

    if (seedPaths.has(candidate.path)) {
      const reason = input.seedRelation === "changed_file"
        ? "File is changed by the pull request."
        : "File is a deterministic task seed.";
      addCandidateScore(candidate, input.seedRelation, relationScore(input.seedRelation), reason);
    }

    if (seedDirs.has(dirnameOf(candidate.path)) && !seedPaths.has(candidate.path)) {
      addCandidateScore(candidate, "same_directory", relationScore("same_directory"), "File is near a seed file.");
    }

    if (input.includeTests && candidate.kind === "test") {
      const matched = [...seedStems].filter((stem) => candidate.path.toLowerCase().includes(stem.toLowerCase()));
      if (matched.length > 0) {
        addCandidateScore(candidate, "test", relationScore("test"), "Test/spec path matches changed code.", matched);
      }
    }

    if (input.includeConfigs && candidate.kind === "config") {
      const matched = lexical?.matchedTerms.slice(0, 8) ?? [];
      if (matched.length > 0) {
        addCandidateScore(candidate, "config", relationScore("config"), "Repository config matches seeded concepts.", matched);
      }
    }

    if (input.includeDocs && candidate.kind === "docs") {
      const matched = lexical?.matchedTerms.slice(0, 8) ?? [];
      if (matched.length > 0) {
        addCandidateScore(candidate, "docs", relationScore("docs"), "Documentation mentions changed concepts.", matched);
      }
    }

    const canReferenceChangedCode = candidate.kind === "source" || candidate.kind === "test";
    const sameStem = [...seedStems].filter((stem) => basenameStem(candidate.path).toLowerCase() === stem.toLowerCase());
    if (!seedPaths.has(candidate.path) && canReferenceChangedCode && sameStem.length > 0) {
      addCandidateScore(candidate, "similar_abstraction", relationScore("similar_abstraction"), "File has the same abstraction name as changed code.", sameStem);
    }
  }

  const graphResult = graphRankingMatchesDetailed({
    candidates: input.candidates,
    seedPaths: input.seedPaths,
    resolutionSignature: input.importResolutionSignature,
    topology: input.graphTopology,
    baseScores: {
      import_dependency: relationScore("import_dependency"),
      reverse_reference: relationScore("reverse_reference")
    },
    maxDepth: 3,
    decay: 0.6
  });
  for (const match of graphResult.matches) {
    addCandidateScore(
      match.candidate,
      match.relation,
      match.score,
      match.reason,
      match.matchKind === "import" ? [match.matchValue] : [],
      match.matchKind === "symbol" ? [match.matchValue] : []
    );
    const graphScore = scores.get(match.candidate.path);
    if (graphScore !== undefined) {
      if (graphScore.graphDepth === undefined || match.depth < graphScore.graphDepth) {
        graphScore.graphDepth = match.depth;
        graphScore.graphSeedRank = match.seedRank;
      } else if (
        match.depth === graphScore.graphDepth &&
        (graphScore.graphSeedRank === undefined || match.seedRank < graphScore.graphSeedRank)
      ) {
        graphScore.graphSeedRank = match.seedRank;
      }
    }
  }

  return {
    scores,
    lexicalDiagnostics: lexicalResult.diagnostics,
    graphDiagnostics: {
      ...graphResult.diagnostics,
      score_states_omitted: omittedScorePaths.size
    }
  };
}
