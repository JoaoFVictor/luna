import type { Candidate } from "../file-analysis.js";
import {
  importValuesFromGraph,
  primaryDefinitionSymbolsFromGraph,
  reverseReferenceDefinitionTermsFromGraph,
  reverseReferenceDefinitionSymbolsFromGraph,
  reverseReferenceDefinitionSymbolTermsFromGraph,
  reverseReferenceTermsFromOccurrence,
  reverseReferenceSymbolsFromGraph,
  reverseReferenceTermsFromGraph,
  symbolNamesFromGraph,
  unique,
  wordsFrom
} from "./common.js";
import { analyzeHeuristically, heuristicSymbolNames } from "./heuristic.js";
import { analyzeJavaScriptLike } from "./js-ts-vue.js";
import {
  enrichPhpCandidatesWithNikic,
  phpFallbackAnalysis
} from "./php-bridge.js";
export { linkProjectSymbolReferences } from "./project-linker.js";
import type {
  FileSymbolGraph,
  FileSymbolGraphOptions,
  SymbolEngine
} from "./types.js";

export {
  heuristicSymbolNames,
  importValuesFromGraph,
  primaryDefinitionSymbolsFromGraph,
  reverseReferenceDefinitionTermsFromGraph,
  reverseReferenceDefinitionSymbolsFromGraph,
  reverseReferenceDefinitionSymbolTermsFromGraph,
  reverseReferenceTermsFromOccurrence,
  reverseReferenceSymbolsFromGraph,
  reverseReferenceTermsFromGraph,
  symbolNamesFromGraph,
  unique,
  wordsFrom
};
export type { FileSymbolGraph, SymbolEngine };
export type { FileSymbolGraphOptions };

export function analyzeFileSymbolGraph(
  content: string,
  filePath: string,
  options: FileSymbolGraphOptions = {}
): FileSymbolGraph {
  if (filePath.endsWith(".php")) {
    return phpFallbackAnalysis(content, filePath);
  }
  if (/\.(?:[cm]?[jt]sx?|vue)$/u.test(filePath)) {
    return analyzeJavaScriptLike(content, filePath, options);
  }
  return analyzeHeuristically(content, filePath);
}

export async function enrichCandidatesWithSymbolGraph(
  root: string,
  candidates: readonly Candidate[]
): Promise<{
  readonly candidates: readonly Candidate[];
  readonly warnings: readonly string[];
}> {
  return await enrichPhpCandidatesWithNikic(root, candidates);
}
