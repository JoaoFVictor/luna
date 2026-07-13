import type { RankedRelatedContextFile } from "./ranking.js";
import { reservedRelations } from "./relation-policies.js";

export function selectRelatedFiles(
  rankedFiles: readonly RankedRelatedContextFile[],
  changedPaths: ReadonlySet<string>,
  maxFiles: number
): RankedRelatedContextFile[] {
  const selected: RankedRelatedContextFile[] = [];
  const selectedPaths = new Set<string>();
  function add(file: RankedRelatedContextFile): void {
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
  for (const relation of reservedRelations.filter((candidate) =>
    ["test", "config", "docs", "similar_abstraction"].includes(candidate)
  )) {
    const best = remaining.find((file) => file.score_breakdown[relation] !== undefined);
    if (best !== undefined) {
      add(best);
    }
  }
  const directGraphNeighbors = remaining.filter((candidate) =>
    candidate.graphDepth === 1
  ).sort((left, right) =>
    (left.graphSeedRank ?? Number.MAX_SAFE_INTEGER) -
      (right.graphSeedRank ?? Number.MAX_SAFE_INTEGER)
  );
  for (const file of directGraphNeighbors) {
    add(file);
  }
  for (const file of remaining) {
    add(file);
  }
  return selected;
}
