import type { Candidate } from "./file-analysis.js";
import { importTargets, type ProjectImportResolution } from "./import-resolution.js";
import { repositoryIndexCapacityError } from "./repository-index-policy.js";
import {
  reverseReferenceDefinitionSymbolsFromGraph,
  reverseReferenceSymbolsFromGraph
} from "./symbol-analysis/index.js";

export type GraphRankingRelation = "import_dependency" | "reverse_reference";

export type GraphNeighbor = {
  readonly path: string;
  readonly matchKind: "import" | "symbol";
  readonly matchValue: string;
  readonly reason: string;
  readonly relation: GraphRankingRelation;
};

export type GraphTopology = {
  readonly candidateByPath: ReadonlyMap<string, Candidate>;
  readonly neighborsByPath: ReadonlyMap<string, readonly GraphNeighbor[]>;
  readonly resolutionSignature: string;
  readonly estimated_retained_bytes: number;
};

export type GraphRankingMatch = GraphNeighbor & {
  readonly candidate: Candidate;
  readonly depth: number;
  readonly seedRank: number;
  readonly score: number;
};

export type GraphQueryDiagnostics = {
  readonly edges_visited: number;
  readonly edges_omitted: number;
  readonly edges_omitted_lower_bound: boolean;
  readonly matches_omitted: number;
  readonly frontier_omitted: number;
};

export type GraphRankingResult = {
  readonly matches: readonly GraphRankingMatch[];
  readonly diagnostics: GraphQueryDiagnostics;
};

const MAX_GRAPH_EDGE_VISITS = 20_000;
const MAX_GRAPH_MATCHES = 5_000;
const MAX_GRAPH_FRONTIER = 5_000;

export function buildGraphTopology(
  candidates: readonly Candidate[],
  importResolution: ProjectImportResolution,
  capacity?: { readonly retainedBytesAlready: number; readonly maxRetainedBytes: number }
): GraphTopology {
  const resolutionSignature = importResolution.signature;
  const candidateByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  const outgoing = new Map<string, GraphNeighbor[]>();
  const incoming = new Map<string, GraphNeighbor[]>();
  let estimatedRetainedBytes = candidates.length * 128;

  function retainedNeighborBytes(neighbor: GraphNeighbor): number {
    return 160 + 2 * (
      neighbor.path.length + neighbor.matchValue.length + neighbor.reason.length +
      neighbor.relation.length + neighbor.matchKind.length
    );
  }

  function retain(bytes: number): void {
    estimatedRetainedBytes += bytes;
    if (
      capacity !== undefined &&
      capacity.retainedBytesAlready + estimatedRetainedBytes > capacity.maxRetainedBytes
    ) {
      throw repositoryIndexCapacityError({
        phase: "analysis",
        resource: "retained_index_bytes",
        observed: capacity.retainedBytesAlready + estimatedRetainedBytes,
        limit: capacity.maxRetainedBytes
      });
    }
  }

  function connect(from: string, to: string, forward: GraphNeighbor, reverse: GraphNeighbor): void {
    retain(retainedNeighborBytes(forward) + retainedNeighborBytes(reverse));
    const outgoingNeighbors = outgoing.get(from);
    if (outgoingNeighbors === undefined) {
      outgoing.set(from, [forward]);
    } else {
      outgoingNeighbors.push(forward);
    }
    const incomingNeighbors = incoming.get(to);
    if (incomingNeighbors === undefined) {
      incoming.set(to, [reverse]);
    } else {
      incomingNeighbors.push(reverse);
    }
  }

  for (const candidate of candidates) {
    for (const importValue of candidate.imports) {
      for (const target of importTargets(importValue, candidate.path, importResolution)) {
        if (!candidateByPath.has(target) || target === candidate.path) {
          continue;
        }
        connect(
          candidate.path,
          target,
          {
            path: target,
            matchKind: "import",
            matchValue: importValue,
            reason: `import/include relation through ${candidate.path}`,
            relation: "import_dependency"
          },
          {
            path: candidate.path,
            matchKind: "import",
            matchValue: importValue,
            reason: `reverse import/include relation through ${target}`,
            relation: "reverse_reference"
          }
        );
      }
    }
  }

  const definitionOwners = new Map<string, string[]>();
  for (const candidate of candidates) {
    for (const symbol of reverseReferenceDefinitionSymbolsFromGraph(candidate.symbol_graph)) {
      retain(64);
      const owners = definitionOwners.get(symbol);
      if (owners === undefined) {
        definitionOwners.set(symbol, [candidate.path]);
      } else {
        owners.push(candidate.path);
      }
    }
  }
  for (const candidate of candidates) {
    for (const symbol of reverseReferenceSymbolsFromGraph(candidate.symbol_graph)) {
      for (const ownerPath of definitionOwners.get(symbol) ?? []) {
        if (ownerPath === candidate.path) {
          continue;
        }
        connect(
          candidate.path,
          ownerPath,
          {
            path: ownerPath,
            matchKind: "symbol",
            matchValue: symbol,
            reason: `symbol dependency through ${candidate.path}`,
            relation: "import_dependency"
          },
          {
            path: candidate.path,
            matchKind: "symbol",
            matchValue: symbol,
            reason: `reverse symbol reference through ${ownerPath}`,
            relation: "reverse_reference"
          }
        );
      }
    }
  }

  const neighborsByPath = new Map<string, readonly GraphNeighbor[]>();
  for (const candidate of candidates) {
    const deduped = new Map<string, GraphNeighbor>();
    for (const neighbor of [
      ...(outgoing.get(candidate.path) ?? []),
      ...(incoming.get(candidate.path) ?? [])
    ]) {
      const key = `${neighbor.path}\0${neighbor.relation}\0${neighbor.matchKind}\0${neighbor.matchValue}`;
      if (!deduped.has(key)) {
        deduped.set(key, neighbor);
      }
    }
    neighborsByPath.set(candidate.path, [...deduped.values()].sort((left, right) =>
      left.path.localeCompare(right.path) || left.relation.localeCompare(right.relation)
    ));
  }
  return {
    candidateByPath,
    neighborsByPath,
    resolutionSignature,
    estimated_retained_bytes: estimatedRetainedBytes
  };
}

export function graphRankingMatches(input: {
  readonly candidates: readonly Candidate[];
  readonly seedPaths: readonly string[];
  readonly resolutionSignature: string;
  readonly topology: GraphTopology;
  readonly baseScores: Readonly<Record<GraphRankingRelation, number>>;
  readonly maxDepth: number;
  readonly decay: number;
}): GraphRankingMatch[] {
  return [...graphRankingMatchesDetailed(input).matches];
}

export function graphRankingMatchesDetailed(input: {
  readonly candidates: readonly Candidate[];
  readonly seedPaths: readonly string[];
  readonly resolutionSignature: string;
  readonly topology: GraphTopology;
  readonly baseScores: Readonly<Record<GraphRankingRelation, number>>;
  readonly maxDepth: number;
  readonly decay: number;
}): GraphRankingResult {
  const topology = input.topology;
  if (topology.resolutionSignature !== input.resolutionSignature) {
    throw new Error("Graph topology does not match the supplied import resolution.");
  }
  const { candidateByPath, neighborsByPath } = topology;
  const neighbors = (filePath: string): readonly GraphNeighbor[] =>
    neighborsByPath.get(filePath) ?? [];

  const seedPaths = [...new Set(input.seedPaths)];
  const matches: GraphRankingMatch[] = [];
  const visitedDepth = new Map<string, number>(seedPaths.map((filePath) => [filePath, 0]));
  let currentFrontiers = seedPaths.map((path, seedRank) => ({
    seedRank,
    nodes: [{ path, neighborIndex: 0 }],
    nodeIndex: 0
  }));
  let frontierEntries = seedPaths.length;
  let edgesVisited = 0;
  let edgesOmitted = 0;
  let edgesOmittedLowerBound = false;
  let matchesOmitted = 0;
  let frontierOmitted = 0;
  traversal: for (let depth = 0; depth < input.maxDepth; depth += 1) {
    const nextDepth = depth + 1;
    const nextFrontiers = seedPaths.map((_, seedRank) => ({
      seedRank,
      nodes: [] as Array<{ path: string; neighborIndex: number }>,
      nodeIndex: 0
    }));
    let madeProgress = true;
    while (madeProgress) {
      madeProgress = false;
      for (const frontier of currentFrontiers) {
        while (frontier.nodeIndex < frontier.nodes.length) {
          const node = frontier.nodes[frontier.nodeIndex];
          if (node === undefined) break;
          const nodeNeighbors = neighbors(node.path);
          if (node.neighborIndex >= nodeNeighbors.length) {
            frontier.nodeIndex += 1;
            continue;
          }
          if (edgesVisited >= MAX_GRAPH_EDGE_VISITS) {
            edgesOmitted = knownRemainingEdges(currentFrontiers, nextFrontiers, neighbors, nextDepth, input.maxDepth);
            edgesOmittedLowerBound = true;
            break traversal;
          }
          const neighbor = nodeNeighbors[node.neighborIndex];
          node.neighborIndex += 1;
          madeProgress = true;
          if (neighbor === undefined) break;
          edgesVisited += 1;
          const candidate = candidateByPath.get(neighbor.path);
          const previousDepth = visitedDepth.get(neighbor.path);
          if (candidate === undefined || (previousDepth !== undefined && previousDepth < nextDepth)) {
            break;
          }
          const totalDegree = neighbors(neighbor.path).length;
          const hubPenalty = 1 + Math.log2(1 + Math.max(0, totalDegree - 8)) * 0.25;
          const match = {
            ...neighbor,
            candidate,
            depth: nextDepth,
            seedRank: frontier.seedRank,
            score: input.baseScores[neighbor.relation] *
              input.decay ** (nextDepth - 1) /
              hubPenalty,
            reason: `${nextDepth}-hop ${neighbor.reason}.`
          } satisfies GraphRankingMatch;
          if (matches.length < MAX_GRAPH_MATCHES) matches.push(match);
          else matchesOmitted += 1;
          if (previousDepth === undefined) {
            visitedDepth.set(neighbor.path, nextDepth);
            if (frontierEntries < MAX_GRAPH_FRONTIER) {
              nextFrontiers[frontier.seedRank]?.nodes.push({
                path: neighbor.path,
                neighborIndex: 0
              });
              frontierEntries += 1;
            } else {
              frontierOmitted += 1;
            }
          }
          break;
        }
      }
    }
    currentFrontiers = nextFrontiers;
  }
  return {
    matches,
    diagnostics: {
      edges_visited: edgesVisited,
      edges_omitted: edgesOmitted,
      edges_omitted_lower_bound: edgesOmittedLowerBound,
      matches_omitted: matchesOmitted,
      frontier_omitted: frontierOmitted
    }
  };
}

function knownRemainingEdges(
  current: readonly { readonly nodes: readonly { readonly path: string; readonly neighborIndex: number }[]; readonly nodeIndex: number }[],
  next: readonly { readonly nodes: readonly { readonly path: string }[] }[],
  neighbors: (filePath: string) => readonly GraphNeighbor[],
  nextDepth: number,
  maxDepth: number
): number {
  let omitted = 0;
  for (const frontier of current) {
    for (let index = frontier.nodeIndex; index < frontier.nodes.length; index += 1) {
      const node = frontier.nodes[index];
      if (node !== undefined) omitted += Math.max(0, neighbors(node.path).length - node.neighborIndex);
    }
  }
  if (nextDepth < maxDepth) {
    for (const frontier of next) {
      for (const node of frontier.nodes) omitted += neighbors(node.path).length;
    }
  }
  return omitted;
}
