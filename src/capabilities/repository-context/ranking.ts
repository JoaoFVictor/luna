import type { RepoContext } from "../git/diff/types.js";
import {
  basenameStem,
  type Candidate,
  dirnameOf,
  importTargets,
  type ProjectImportResolution,
  unique
} from "./file-analysis.js";
import {
  excerptFrom,
  type FocusRange
} from "./excerpts.js";
import {
  primaryDefinitionSymbolsFromGraph,
  reverseReferenceDefinitionSymbolsFromGraph,
  reverseReferenceSymbolsFromGraph
} from "./symbol-analysis/index.js";
import type {
  RelatedContextFile,
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

const RELATION_POLICIES: Record<RelatedContextRelation, {
  readonly score: number;
  readonly reserve_slot: boolean;
  readonly selection_priority: number;
  readonly source: string;
  readonly primary_reasons: readonly string[];
}> = {
  changed_file: {
    score: 100,
    reserve_slot: false,
    selection_priority: 0,
    source: "diff",
    primary_reasons: ["File is changed by the pull request."]
  },
  reverse_reference: {
    score: 95,
    reserve_slot: true,
    selection_priority: 10,
    source: "reverse_scan",
    primary_reasons: [
      "File imports/includes changed code.",
      "File references changed symbols."
    ]
  },
  import_dependency: {
    score: 85,
    reserve_slot: true,
    selection_priority: 20,
    source: "import_scan",
    primary_reasons: ["Changed file imports/includes this file."]
  },
  test: {
    score: 60,
    reserve_slot: true,
    selection_priority: 30,
    source: "test_mapping",
    primary_reasons: ["Test/spec path matches changed code."]
  },
  same_directory: {
    score: 28,
    reserve_slot: false,
    selection_priority: 80,
    source: "path_scan",
    primary_reasons: ["File is near a changed file."]
  },
  config: {
    score: 24,
    reserve_slot: false,
    selection_priority: 70,
    source: "config_mapping",
    primary_reasons: ["Repository config can affect changed code review."]
  },
  docs: {
    score: 16,
    reserve_slot: false,
    selection_priority: 75,
    source: "doc_mapping",
    primary_reasons: ["Documentation mentions changed concepts."]
  },
  similar_abstraction: {
    score: 12,
    reserve_slot: true,
    selection_priority: 40,
    source: "similarity_scan",
    primary_reasons: ["File has the same abstraction name as changed code."]
  }
};

const PATH_ROLE_POLICIES: readonly {
  readonly pattern: RegExp;
  readonly import_dependency_bonus: number;
  readonly reverse_reference_bonus: number;
}[] = [
  {
    pattern: /(^|\/)(pages?|routes?|controllers?|commands?|jobs?|listeners?|middlewares?|crontabs?|layouts?)(\/|$)/iu,
    import_dependency_bonus: 6,
    reverse_reference_bonus: 8
  },
  {
    pattern: /(^|\/)(services?|repositories?|composables?|stores?)(\/|$)/iu,
    import_dependency_bonus: 7,
    reverse_reference_bonus: 5
  },
  {
    pattern: /(^|\/)(components?)(\/|$)/iu,
    import_dependency_bonus: 5,
    reverse_reference_bonus: 4
  },
  {
    pattern: /(^|\/)(models?|entities?|types?|enums?)(\/|$)/iu,
    import_dependency_bonus: 1,
    reverse_reference_bonus: 1
  }
];

const CONFIG_PATH_POLICIES: readonly {
  readonly pattern: RegExp;
  readonly bonus: number;
}[] = [
  {
    pattern: /(^|\/)config(\/|$)/iu,
    bonus: 10
  },
  {
    pattern: /(^|\/)(composer|package|tsconfig|jsconfig|phpunit|phpstan|psalm|nuxt\.config|vite\.config|next\.config|webpack\.config)[^/]*$/iu,
    bonus: 8
  },
  {
    pattern: /(^|\/)(\.github|\.gitlab|docker-compose|Dockerfile|\.circleci)(\/|$|[.\w-]*$)/iu,
    bonus: 2
  }
];

const RESERVED_RELATIONS: readonly RelatedContextRelation[] = Object.entries(RELATION_POLICIES)
  .filter(([, policy]) => policy.reserve_slot)
  .sort((left, right) => left[1].selection_priority - right[1].selection_priority)
  .map(([relation]) => relation as RelatedContextRelation);

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

export function primaryReasonForRelation(file: RelatedContextFile): string {
  const preferred = RELATION_POLICIES[file.relation].primary_reasons
    .find((reason) => file.reasons.includes(reason));

  return preferred ?? file.reasons[0] ?? "Selected by repository context ranking.";
}

export function sourceFrom(relation: RelatedContextRelation): string {
  return RELATION_POLICIES[relation].source;
}

function pathRoleBonus(pathValue: string, relation: "import_dependency" | "reverse_reference"): number {
  const normalized = pathValue.split("\\").join("/");
  const policy = PATH_ROLE_POLICIES.find((item) => item.pattern.test(normalized));
  if (policy === undefined) {
    return 0;
  }
  return relation === "import_dependency"
    ? policy.import_dependency_bonus
    : policy.reverse_reference_bonus;
}

function configPathBonus(pathValue: string): number {
  const normalized = pathValue.split("\\").join("/");
  return CONFIG_PATH_POLICIES.find((item) => item.pattern.test(normalized))?.bonus ?? 0;
}

export function toRelatedFile(
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

function includesToken(content: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scoreCandidates(input: {
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
  const seedDirs = new Set(input.repoContext.files
    .map((file) => dirnameOf(file.path))
    .filter((directory) => directory !== ""));
  const seedStems = new Set(input.repoContext.files.map((file) => basenameStem(file.path)));
  const seedSymbols = unique([
    ...input.candidates
      .filter((candidate) => changedPaths.has(candidate.path))
      .flatMap((candidate) => reverseReferenceDefinitionSymbolsFromGraph(candidate.symbol_graph))
  ]);
  const seedSymbolsByPath = new Map(input.candidates
    .filter((candidate) => changedPaths.has(candidate.path))
    .map((candidate) => [
      candidate.path,
      primaryDefinitionSymbolsFromGraph(candidate.symbol_graph)
    ]));

  for (const candidate of input.candidates) {
    if (changedPaths.has(candidate.path)) {
      addScore(scores, candidate, "changed_file", RELATION_POLICIES.changed_file.score, "File is changed by the pull request.");
    }

    if (seedDirs.has(dirnameOf(candidate.path)) && !changedPaths.has(candidate.path)) {
      addScore(scores, candidate, "same_directory", RELATION_POLICIES.same_directory.score, "File is near a changed file.");
    }

    if (input.includeTests && candidate.kind === "test") {
      const matched = [...seedStems].filter((stem) => candidate.path.toLowerCase().includes(stem.toLowerCase()));
      if (matched.length > 0) {
        addScore(scores, candidate, "test", RELATION_POLICIES.test.score, "Test/spec path matches changed code.", matched);
      }
    }

    if (input.includeConfigs && candidate.kind === "config") {
      addScore(
        scores,
        candidate,
        "config",
        RELATION_POLICIES.config.score + configPathBonus(candidate.path),
        "Repository config can affect changed code review."
      );
    }

    if (input.includeDocs && candidate.kind === "docs") {
      const matched = input.queryTerms.filter((term) => includesToken(candidate.content, term)).slice(0, 8);
      if (matched.length > 0) {
        addScore(scores, candidate, "docs", RELATION_POLICIES.docs.score, "Documentation mentions changed concepts.", matched);
      }
    }

    const canReferenceChangedCode = candidate.kind === "source" || candidate.kind === "test";
    const referenceSymbols = canReferenceChangedCode
      ? reverseReferenceSymbolsFromGraph(candidate.symbol_graph)
      : [];
    const matchedSymbols = canReferenceChangedCode
      ? seedSymbols.filter((symbol) => referenceSymbols.includes(symbol)).slice(0, 12)
      : [];
    if (!changedPaths.has(candidate.path) && matchedSymbols.length > 0) {
      addScore(
        scores,
        candidate,
        "reverse_reference",
        RELATION_POLICIES.reverse_reference.score + pathRoleBonus(candidate.path, "reverse_reference"),
        "File references changed symbols.",
        [],
        matchedSymbols
      );
    }

    const sameStem = [...seedStems].filter((stem) => basenameStem(candidate.path).toLowerCase() === stem.toLowerCase());
    if (!changedPaths.has(candidate.path) && canReferenceChangedCode && sameStem.length > 0) {
      addScore(scores, candidate, "similar_abstraction", RELATION_POLICIES.similar_abstraction.score, "File has the same abstraction name as changed code.", sameStem);
    }
  }

  for (const seed of input.candidates.filter((candidate) => changedPaths.has(candidate.path))) {
    for (const importValue of seed.imports) {
      for (const target of importTargets(importValue, seed.path, input.importResolution)) {
        const candidate = candidateByPath.get(target);
        if (candidate !== undefined) {
          addScore(
            scores,
            candidate,
            "import_dependency",
            RELATION_POLICIES.import_dependency.score + pathRoleBonus(candidate.path, "import_dependency"),
            "Changed file imports/includes this file.",
            [importValue]
          );
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
        addScore(
          scores,
          candidate,
          "reverse_reference",
          RELATION_POLICIES.reverse_reference.score + pathRoleBonus(candidate.path, "reverse_reference"),
          "File imports/includes changed code.",
          [importValue],
          seedSymbolsByPath.get(matchedChangedPath) ?? []
        );
      }
    }
  }

  return scores;
}

export function selectRelatedFiles(
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
