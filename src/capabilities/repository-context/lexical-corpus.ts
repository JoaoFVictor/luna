import type { Candidate } from "./file-analysis.js";
import { repositoryIndexCapacityError } from "./repository-index-policy.js";
import {
  MAX_FUZZY_TERMS_PER_BUCKET,
  lexicalTermsFrom,
  trigrams,
  type LexicalCorpus,
  type LexicalPosting
} from "./lexical-ranking.js";

function frequenciesFrom(tokens: readonly string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}

export function buildLexicalCorpus(
  candidates: readonly Candidate[],
  capacity?: { readonly retainedBytesAlready: number; readonly maxRetainedBytes: number }
): LexicalCorpus {
  const mutablePostings = new Map<string, Map<number, { path: number; symbols: number; content: number }>>();
  const lengths = { path: [] as number[], symbols: [] as number[], content: [] as number[] };
  let estimatedRetainedBytes = candidates.length * 64;
  function retain(bytes: number): void {
    estimatedRetainedBytes += bytes;
    if (capacity !== undefined &&
      capacity.retainedBytesAlready + estimatedRetainedBytes > capacity.maxRetainedBytes) {
      throw repositoryIndexCapacityError({
        phase: "analysis", resource: "retained_index_bytes",
        observed: capacity.retainedBytesAlready + estimatedRetainedBytes,
        limit: capacity.maxRetainedBytes
      });
    }
  }
  for (const [document, candidate] of candidates.entries()) {
    const fields = {
      path: lexicalTermsFrom(candidate.path),
      symbols: lexicalTermsFrom(candidate.symbols.join(" ")),
      content: lexicalTermsFrom(candidate.content)
    };
    lengths.path.push(fields.path.length);
    lengths.symbols.push(fields.symbols.length);
    lengths.content.push(fields.content.length);
    retain(24);
    for (const field of ["path", "symbols", "content"] as const) {
      for (const [term, frequency] of frequenciesFrom(fields[field])) {
        let byDocument = mutablePostings.get(term);
        if (byDocument === undefined) {
          byDocument = new Map();
          mutablePostings.set(term, byDocument);
          retain(128 + term.length * 2);
        }
        const posting = byDocument.get(document) ?? { path: 0, symbols: 0, content: 0 };
        if (!byDocument.has(document)) {
          retain(64);
        }
        posting[field] = frequency;
        byDocument.set(document, posting);
      }
    }
  }
  const vocabulary = [...mutablePostings.keys()].sort();
  const postings = new Map<string, readonly LexicalPosting[]>();
  const fuzzyBuckets = new Map<string, { terms: string[]; omitted: number }>();
  for (const term of vocabulary) {
    postings.set(term, [...(mutablePostings.get(term)?.entries() ?? [])]
      .map(([document, frequencies]) => ({ document, ...frequencies }))
      .sort((left, right) =>
        Number(right.path > 0 || right.symbols > 0) -
          Number(left.path > 0 || left.symbols > 0) ||
        left.document - right.document
      ));
    mutablePostings.delete(term);
    for (const trigram of trigrams(term)) {
      const bucket = fuzzyBuckets.get(trigram);
      if (bucket === undefined) {
        fuzzyBuckets.set(trigram, { terms: [term], omitted: 0 });
        retain(112 + trigram.length * 2 + 16);
      } else if (bucket.terms.length < MAX_FUZZY_TERMS_PER_BUCKET) {
        bucket.terms.push(term);
        retain(16);
      } else {
        bucket.omitted += 1;
      }
    }
  }
  const divisor = Math.max(1, candidates.length);
  return {
    candidates, postings, vocabulary, fuzzyBuckets, lengths,
    average: {
      path: lengths.path.reduce((sum, value) => sum + value, 0) / divisor,
      symbols: lengths.symbols.reduce((sum, value) => sum + value, 0) / divisor,
      content: lengths.content.reduce((sum, value) => sum + value, 0) / divisor
    },
    estimated_retained_bytes: estimatedRetainedBytes
  };
}
