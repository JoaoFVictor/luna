import type { Candidate } from "../file-analysis.js";
import {
  importValuesFromAnalysis,
  symbolNamesFromAnalysis,
  unique,
  wordsFrom
} from "./common.js";
import { analyzeHeuristically, heuristicSymbolNames } from "./heuristic.js";
import { analyzeJavaScriptLike } from "./js-ts-vue.js";
import {
  enrichPhpCandidatesWithNikic,
  phpFallbackAnalysis
} from "./php-bridge.js";
import type {
  FileSymbolAnalysis,
  FileSymbolAnalysisOptions,
  SymbolEngine
} from "./types.js";

export {
  heuristicSymbolNames,
  importValuesFromAnalysis,
  symbolNamesFromAnalysis,
  unique,
  wordsFrom
};
export type { FileSymbolAnalysis, SymbolEngine };
export type { FileSymbolAnalysisOptions };

export function analyzeFileSymbols(
  content: string,
  filePath: string,
  options: FileSymbolAnalysisOptions = {}
): FileSymbolAnalysis {
  if (filePath.endsWith(".php")) {
    return phpFallbackAnalysis(content, filePath);
  }
  if (/\.(?:[cm]?[jt]sx?|vue)$/u.test(filePath)) {
    return analyzeJavaScriptLike(content, filePath, options);
  }
  return analyzeHeuristically(content, filePath);
}

export async function enrichCandidatesWithAst(
  root: string,
  candidates: readonly Candidate[]
): Promise<{
  readonly candidates: readonly Candidate[];
  readonly warnings: readonly string[];
}> {
  return await enrichPhpCandidatesWithNikic(root, candidates);
}
