import { type Candidate, unique } from "./file-analysis.js";

type LexicalField = {
  readonly length: number;
  readonly frequencies: ReadonlyMap<string, number>;
};

type LexicalDocument = {
  readonly document: number;
  readonly path: LexicalField;
  readonly symbols: LexicalField;
  readonly content: LexicalField;
};

export type LexicalPosting = {
  readonly document: number;
  readonly path: number;
  readonly symbols: number;
  readonly content: number;
};

type FuzzyBucket = {
  readonly terms: readonly string[];
  readonly omitted: number;
};

export type LexicalCorpus = {
  readonly candidates: readonly Candidate[];
  readonly postings: ReadonlyMap<string, readonly LexicalPosting[]>;
  readonly vocabulary: readonly string[];
  readonly fuzzyBuckets: ReadonlyMap<string, FuzzyBucket>;
  readonly lengths: {
    readonly path: readonly number[];
    readonly symbols: readonly number[];
    readonly content: readonly number[];
  };
  readonly average: {
    readonly path: number;
    readonly symbols: number;
    readonly content: number;
  };
  readonly estimated_retained_bytes: number;
};

export type LexicalQueryDiagnostics = {
  readonly fuzzy_candidates_considered: number;
  readonly fuzzy_candidates_omitted: number;
  readonly posting_documents_considered: number;
  readonly posting_documents_omitted: number;
  readonly query_documents_omitted: number;
};

export type LexicalCandidateScoreResult = {
  readonly scores: ReadonlyMap<string, LexicalCandidateScore>;
  readonly diagnostics: LexicalQueryDiagnostics;
};

const MAX_FUZZY_CANDIDATES_PER_TERM = 512;
export const MAX_FUZZY_TERMS_PER_BUCKET = 1_024;
const MAX_FUZZY_BUCKET_VISITS_PER_TERM = 4_096;
const MAX_LEXICAL_TERM_CHARACTERS = 128;
const MAX_QUERY_DOCUMENTS = 4_096;
const MAX_POSTING_VISITS = 100_000;
const MAX_POSTING_VISITS_PER_TERM = 8_192;

export type LexicalCandidateScore = {
  readonly path: string;
  readonly score: number;
  readonly identityScore: number;
  readonly matchedTerms: readonly string[];
  readonly matchedSymbols: readonly string[];
};

const STOP_TERMS = new Set([
  "a", "an", "and", "as", "at", "be", "by", "da", "das", "de", "del", "do", "dos",
  "du", "e", "el", "em", "en", "for", "from", "in", "is", "la", "le", "na", "no",
  "of", "on", "or", "the", "to", "um", "uma", "with"
]);

function morphologyVariants(token: string): string[] {
  const variants = [token];
  if (token.length >= 5 && token.endsWith("ies")) {
    variants.push(`${token.slice(0, -3)}y`);
  } else if (token.length >= 5 && token.endsWith("s") && !/(?:is|ss|us)$/u.test(token)) {
    variants.push(token.slice(0, -1));
  }
  if (token.length >= 5 && token.endsWith("ed")) {
    const stem = token.slice(0, -2);
    variants.push(stem, `${stem}e`);
  }
  if (token.length >= 6 && token.endsWith("ing")) {
    const stem = token.slice(0, -3);
    variants.push(stem, `${stem}e`);
  }
  return unique(variants);
}

export function lexicalTermsFrom(value: string): string[] {
  const rawTokens = value
    .normalize("NFKC")
    .replace(/([\p{L}][\p{L}\p{N}]{1,15})-(\p{N}{1,10})/gu, "$1$2")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return rawTokens
    .filter((token) =>
      token.length >= 2 &&
      token.length <= MAX_LEXICAL_TERM_CHARACTERS &&
      !/^\p{N}+$/u.test(token) &&
      !STOP_TERMS.has(token)
    )
    .flatMap(morphologyVariants);
}

export function trigrams(term: string): string[] {
  if (term.length < 4) {
    return [];
  }
  const padded = `^${term}$`;
  return unique(Array.from({ length: Math.max(0, padded.length - 2) }, (_, index) =>
    padded.slice(index, index + 3)
  ));
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  if (Math.abs(left.length - right.length) > 1) {
    return false;
  }
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  let shorterIndex = 0;
  let longerIndex = 0;
  let edits = 0;
  while (shorterIndex < shorter.length && longerIndex < longer.length) {
    if (shorter[shorterIndex] === longer[longerIndex]) {
      shorterIndex += 1;
      longerIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) {
      return false;
    }
    if (shorter.length === longer.length) {
      shorterIndex += 1;
    }
    longerIndex += 1;
  }
  return edits + (longer.length - longerIndex) <= 1;
}

function normalizedTermFrequency(
  field: LexicalField,
  term: string,
  averageLength: number,
  weight: number,
  lengthNormalization: number
): number {
  const frequency = field.frequencies.get(term) ?? 0;
  if (frequency === 0) {
    return 0;
  }
  const normalizedLength = averageLength === 0 ? 1 : field.length / averageLength;
  return weight * frequency /
    (1 - lengthNormalization + lengthNormalization * normalizedLength);
}

function queryDocuments(
  corpus: LexicalCorpus,
  normalizedTerms: readonly string[]
): { readonly documents: Map<number, LexicalDocument>; readonly diagnostics: LexicalQueryDiagnostics } {
  const documents = new Map<number, {
    path: Map<string, number>;
    symbols: Map<string, number>;
    content: Map<string, number>;
  }>();
  const matchedCorpusTerms = new Map<string, string>();
  let fuzzyCandidatesConsidered = 0;
  let fuzzyCandidatesOmitted = 0;
  let postingDocumentsConsidered = 0;
  let postingDocumentsOmitted = 0;
  let queryDocumentsOmitted = 0;
  for (const queryTerm of normalizedTerms) {
    if (corpus.postings.has(queryTerm)) {
      matchedCorpusTerms.set(queryTerm, queryTerm);
    }
    if (queryTerm.length < 4) {
      continue;
    }
    const candidateCounts = new Map<string, number>();
    const queryBuckets = trigrams(queryTerm)
      .flatMap((trigram) => {
        const bucket = corpus.fuzzyBuckets.get(trigram);
        return bucket === undefined ? [] : [{ trigram, bucket }];
      })
      .sort((left, right) =>
        left.bucket.terms.length - right.bucket.terms.length ||
        left.trigram.localeCompare(right.trigram)
      );
    let bucketVisits = 0;
    for (const { bucket } of queryBuckets) {
      fuzzyCandidatesOmitted += bucket?.omitted ?? 0;
      for (const candidate of bucket.terms) {
        if (bucketVisits >= MAX_FUZZY_BUCKET_VISITS_PER_TERM) {
          fuzzyCandidatesOmitted += 1;
          continue;
        }
        bucketVisits += 1;
        candidateCounts.set(candidate, (candidateCounts.get(candidate) ?? 0) + 1);
      }
    }
    const rankedCandidates = [...candidateCounts.entries()].sort((left, right) =>
      right[1] - left[1] || left[0].localeCompare(right[0])
    );
    fuzzyCandidatesConsidered += Math.min(rankedCandidates.length, MAX_FUZZY_CANDIDATES_PER_TERM);
    fuzzyCandidatesOmitted += Math.max(0, rankedCandidates.length - MAX_FUZZY_CANDIDATES_PER_TERM);
    for (const [candidate] of rankedCandidates.slice(0, MAX_FUZZY_CANDIDATES_PER_TERM)) {
      if (!matchedCorpusTerms.has(candidate) && editDistanceAtMostOne(candidate, queryTerm)) {
        matchedCorpusTerms.set(candidate, queryTerm);
      }
    }
  }
  const rankedCorpusTerms = [...matchedCorpusTerms].sort((left, right) =>
    (corpus.postings.get(left[0])?.length ?? 0) -
      (corpus.postings.get(right[0])?.length ?? 0) ||
    left[0].localeCompare(right[0])
  );
  for (const [corpusTerm, matchedTerm] of rankedCorpusTerms) {
    const postings = corpus.postings.get(corpusTerm) ?? [];
    const visitLimit = Math.min(
      postings.length,
      MAX_POSTING_VISITS_PER_TERM,
      Math.max(0, MAX_POSTING_VISITS - postingDocumentsConsidered)
    );
    const identityPostings: LexicalPosting[] = [];
    const contentPostings: LexicalPosting[] = [];
    for (let index = 0; index < visitLimit; index += 1) {
      const posting = postings[index];
      if (posting !== undefined) {
        postingDocumentsConsidered += 1;
        (posting.path > 0 || posting.symbols > 0 ? identityPostings : contentPostings)
          .push(posting);
      }
    }
    postingDocumentsOmitted += postings.length - visitLimit;
    for (const posting of [...identityPostings, ...contentPostings]) {
      if (!documents.has(posting.document) && documents.size >= MAX_QUERY_DOCUMENTS) {
        queryDocumentsOmitted += 1;
        continue;
      }
      const document = documents.get(posting.document) ?? {
        path: new Map(),
        symbols: new Map(),
        content: new Map()
      };
      for (const field of ["path", "symbols", "content"] as const) {
        if (posting[field] > 0) {
          document[field].set(
            matchedTerm,
            (document[field].get(matchedTerm) ?? 0) + posting[field]
          );
        }
      }
      documents.set(posting.document, document);
    }
  }
  return {
    documents: new Map([...documents.entries()].map(([document, fields]) => [document, {
    document,
    path: { length: corpus.lengths.path[document] ?? 0, frequencies: fields.path },
    symbols: { length: corpus.lengths.symbols[document] ?? 0, frequencies: fields.symbols },
    content: { length: corpus.lengths.content[document] ?? 0, frequencies: fields.content }
    }])),
    diagnostics: {
      fuzzy_candidates_considered: fuzzyCandidatesConsidered,
      fuzzy_candidates_omitted: fuzzyCandidatesOmitted,
      posting_documents_considered: postingDocumentsConsidered,
      posting_documents_omitted: postingDocumentsOmitted,
      query_documents_omitted: queryDocumentsOmitted
    }
  };
}

export function lexicalCandidateScoresDetailed(
  candidates: readonly Candidate[],
  queryTerms: readonly string[],
  corpus: LexicalCorpus
): LexicalCandidateScoreResult {
  const normalizedTerms = unique(queryTerms.flatMap((term) => lexicalTermsFrom(term)));
  if (normalizedTerms.length === 0 || candidates.length === 0) {
    return {
      scores: new Map(),
      diagnostics: {
        fuzzy_candidates_considered: 0,
        fuzzy_candidates_omitted: 0,
        posting_documents_considered: 0,
        posting_documents_omitted: 0,
        query_documents_omitted: 0
      }
    };
  }
  if (corpus.candidates !== candidates) {
    throw new Error("Lexical corpus does not belong to the supplied candidate index.");
  }
  const query = queryDocuments(corpus, normalizedTerms);
  const documents = query.documents;
  const documentFrequency = new Map(normalizedTerms.map((term) => [term, 0]));
  for (const document of documents.values()) {
    for (const term of normalizedTerms) {
      if (document.path.frequencies.has(term) || document.symbols.frequencies.has(term) ||
        document.content.frequencies.has(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }

  const scores = new Map<string, LexicalCandidateScore>();
  const k1 = 1.2;
  for (const document of documents.values()) {
    let score = 0;
    let identityScore = 0;
    const matchedTerms: string[] = [];
    const matchedSymbols: string[] = [];
    const pathMatchedTerms: string[] = [];
    for (const term of normalizedTerms) {
      const weightedFrequency =
        normalizedTermFrequency(document.path, term, corpus.average.path, 5, 0.35) +
        normalizedTermFrequency(document.symbols, term, corpus.average.symbols, 4, 0.2) +
        normalizedTermFrequency(document.content, term, corpus.average.content, 1, 0.75);
      if (weightedFrequency === 0) {
        continue;
      }
      const frequency = documentFrequency.get(term) ?? 0;
      const inverseDocumentFrequency = Math.log(
        1 + (candidates.length - frequency + 0.5) / (frequency + 0.5)
      );
      score += inverseDocumentFrequency *
        ((k1 + 1) * weightedFrequency) / (k1 + weightedFrequency);
      if (document.path.frequencies.has(term)) {
        score += inverseDocumentFrequency * 0.8;
        identityScore += inverseDocumentFrequency * 5;
        pathMatchedTerms.push(term);
      }
      if (document.symbols.frequencies.has(term)) {
        score += inverseDocumentFrequency * 0.6;
        identityScore += inverseDocumentFrequency * 4;
        matchedSymbols.push(term);
      }
      matchedTerms.push(term);
    }
    score += Math.max(0, unique(pathMatchedTerms).length - 1) * 2;
    const queryCoverage = matchedTerms.length / normalizedTerms.length;
    const candidate = candidates[document.document];
    if (candidate === undefined || score === 0) {
      continue;
    }
    scores.set(candidate.path, {
      path: candidate.path,
      score: score * 10 * (1 + queryCoverage * 0.5),
      identityScore: identityScore * 10 * (1 + queryCoverage * 0.5),
      matchedTerms: unique(matchedTerms),
      matchedSymbols: unique(matchedSymbols)
    });
  }
  return { scores, diagnostics: query.diagnostics };
}

export function lexicalCandidateScores(
  candidates: readonly Candidate[],
  queryTerms: readonly string[],
  corpus: LexicalCorpus
): ReadonlyMap<string, LexicalCandidateScore> {
  return lexicalCandidateScoresDetailed(candidates, queryTerms, corpus).scores;
}
