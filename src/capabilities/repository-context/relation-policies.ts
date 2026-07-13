import type {
  RelatedContextFile,
  RelatedContextRelation
} from "./contracts.js";

type RelationPolicy = {
  readonly score: number;
  readonly reserve_slot: boolean;
  readonly selection_priority: number;
  readonly source: string;
  readonly primary_reasons: readonly string[];
};

const RELATION_POLICIES: Readonly<Record<RelatedContextRelation, RelationPolicy>> = {
  changed_file: {
    score: 100,
    reserve_slot: false,
    selection_priority: 0,
    source: "diff",
    primary_reasons: ["File is changed by the pull request."]
  },
  task_seed: {
    score: 100,
    reserve_slot: false,
    selection_priority: 0,
    source: "task",
    primary_reasons: ["File is a deterministic task seed."]
  },
  query_match: {
    score: 0,
    reserve_slot: false,
    selection_priority: 50,
    source: "lexical_retrieval",
    primary_reasons: ["File matches task or change query terms."]
  },
  reverse_reference: {
    score: 220,
    reserve_slot: true,
    selection_priority: 10,
    source: "dependency_graph",
    primary_reasons: [
      "File imports/includes seeded code.",
      "File imports/includes changed code.",
      "File references changed symbols."
    ]
  },
  import_dependency: {
    score: 220,
    reserve_slot: true,
    selection_priority: 20,
    source: "dependency_graph",
    primary_reasons: ["Seed file imports/includes this file."]
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
    primary_reasons: ["File is near a seed file."]
  },
  config: {
    score: 24,
    reserve_slot: true,
    selection_priority: 40,
    source: "config_mapping",
    primary_reasons: ["Repository config matches seeded concepts."]
  },
  docs: {
    score: 16,
    reserve_slot: true,
    selection_priority: 50,
    source: "doc_mapping",
    primary_reasons: ["Documentation mentions changed concepts."]
  },
  similar_abstraction: {
    score: 12,
    reserve_slot: true,
    selection_priority: 60,
    source: "similarity_scan",
    primary_reasons: ["File has the same abstraction name as changed code."]
  }
};

export function relationScore(relation: RelatedContextRelation): number {
  return RELATION_POLICIES[relation].score;
}

export const reservedRelations: readonly RelatedContextRelation[] = Object.entries(RELATION_POLICIES)
  .filter(([, policy]) => policy.reserve_slot)
  .sort((left, right) => left[1].selection_priority - right[1].selection_priority)
  .map(([relation]) => relation as RelatedContextRelation);

export function relationFrom(scoreBreakdown: Record<string, number>): RelatedContextRelation {
  const ordered: readonly [RelatedContextRelation, string][] = [
    ["changed_file", "changed_file"],
    ["task_seed", "task_seed"],
    ["import_dependency", "import_dependency"],
    ["reverse_reference", "reverse_reference"],
    ["test", "test"],
    ["config", "config"],
    ["docs", "docs"],
    ["query_match", "query_match"],
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
