import { validateFindingEvidence as defaultValidateFindingEvidence } from "./evidence-validator.js";
import {
  findingFingerprint,
  primaryEvidenceKey
} from "./fingerprint.js";
import type { RepoContext } from "../git/diff/types.js";
import { builtInError } from "../../core/built-ins/errors.js";
import type {
  Finding,
  FindingsPayload,
  FindingsReviewOutput
} from "../../core/findings/types.js";
import { FindingsReviewOutputSchema } from "../../core/findings/types.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import {
  findingsFrom,
  requiredInput,
  resolvedInput
} from "../../core/built-ins/state.js";
import type {
  BuiltInStepDependencies,
  MaybePromise
} from "../../core/built-ins/types.js";

type FindingsBuiltInDependencies = BuiltInStepDependencies & {
  validateFindingEvidence?: (
    repoContext: RepoContext,
    findings: readonly Finding[]
  ) => MaybePromise<readonly Finding[]>;
};

type FindingsMergeSource = {
  readonly id: string;
  readonly result: FindingsReviewOutput;
};

const SEVERITY_RANK: Record<Finding["severity"], number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1
};

const CONFIDENCE_RANK: Record<Finding["confidence"], number> = {
  high: 3,
  medium: 2,
  low: 1
};

function fallbackFindingKey(finding: Finding): string {
  return primaryEvidenceKey(finding);
}

function strongerFinding(a: Finding, b: Finding): Finding {
  const severityDelta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (severityDelta !== 0) {
    return severityDelta > 0 ? a : b;
  }

  const confidenceDelta =
    CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
  if (confidenceDelta !== 0) {
    return confidenceDelta > 0 ? a : b;
  }

  return a;
}

function evidenceKey(evidence: Finding["evidence"][number]): string {
  return [
    evidence.path,
    evidence.line_start,
    evidence.line_end,
    evidence.quote ?? ""
  ].join(":");
}

function mergedEvidence(
  a: readonly Finding["evidence"][number][],
  b: readonly Finding["evidence"][number][]
): Finding["evidence"] {
  const byKey = new Map<string, Finding["evidence"][number]>();
  for (const evidence of [...a, ...b]) {
    byKey.set(evidenceKey(evidence), evidence);
  }

  return [...byKey.values()];
}

function mergeSources(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

function withMergeMetadata(finding: Finding, sourceId: string): Finding {
  const sources = [sourceId];
  return {
    ...finding,
    fingerprint: findingFingerprint(finding),
    sources,
    merged_from: sources.length
  };
}

function mergeDuplicateFinding(a: Finding, b: Finding): Finding {
  const winner = strongerFinding(a, b);
  const sources = mergeSources(a.sources, b.sources);
  return {
    ...winner,
    category: winner.category ?? a.category ?? b.category,
    fingerprint: a.fingerprint ?? b.fingerprint ?? findingFingerprint(winner),
    sources,
    merged_from: sources.length,
    evidence: mergedEvidence(a.evidence, b.evidence)
  };
}

function findingsMergeSourcesFrom(input: unknown): readonly FindingsMergeSource[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return requiredInput<readonly FindingsMergeSource[]>(undefined, "sources");
  }

  const sources = (input as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) {
    return requiredInput<readonly FindingsMergeSource[]>(undefined, "sources");
  }

  return sources.map((source, index) => mergeSourceFrom(source, index));
}

function sourceFindings(source: FindingsMergeSource): readonly Finding[] {
  return findingsFrom(source.result);
}

function sourceReviewedRanges(
  source: FindingsMergeSource
): readonly FindingsReviewOutput["reviewed_ranges"][number][] {
  return source.result.reviewed_ranges;
}

function mergeSourceFrom(source: unknown, index: number): FindingsMergeSource {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw builtInError(
      `findings.merge source ${index + 1} must be an object.`,
      "built_in_input_invalid"
    );
  }

  const record = source as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim() === "") {
    throw builtInError(
      `findings.merge source ${index + 1} must include a non-empty id.`,
      "built_in_input_invalid"
    );
  }

  const id = record.id.trim();
  if (
    typeof record.result !== "object" ||
    record.result === null ||
    Array.isArray(record.result)
  ) {
    throw builtInError(
      `findings.merge source ${id} must include an object result.`,
      "built_in_input_invalid"
    );
  }

  const parsed = FindingsReviewOutputSchema.safeParse(record.result);
  if (!parsed.success) {
    throw builtInError(
      `findings.merge source ${id} result must match the findings payload schema.`,
      "built_in_input_invalid"
    );
  }

  return {
    id,
    result: parsed.data
  };
}

function rangeKey(range: NonNullable<FindingsPayload["reviewed_ranges"]>[number]): string {
  return [
    range.path,
    range.line_start,
    range.line_end
  ].join(":");
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export const mergeFindingsBuiltIn = defineBuiltInStep<"findings.merge">({
  name: "findings.merge",
  run({ input }) {
    const sources = findingsMergeSourcesFrom(input);
    const byFingerprint = new Map<string, Finding>();
    const byFallback = new Map<string, string>();
    const reviewedRangesByKey = new Map<
      string,
      NonNullable<FindingsPayload["reviewed_ranges"]>[number]
    >();
    let sourceCount = 0;
    let inputFindingCount = 0;

    for (const source of sources) {
      const sourceId = source.id;
      const findings = sourceFindings(source);
      const reviewedRanges = sourceReviewedRanges(source);
      sourceCount += 1;
      inputFindingCount += findings.length;

      for (const range of reviewedRanges) {
        reviewedRangesByKey.set(rangeKey(range), range);
      }

      for (const finding of findings) {
        const withMetadata = withMergeMetadata(finding, sourceId);
        const fingerprint = withMetadata.fingerprint ?? findingFingerprint(withMetadata);
        const fallbackKey = fallbackFindingKey(withMetadata);
        const existingKey = byFingerprint.has(fingerprint)
          ? fingerprint
          : byFallback.get(fallbackKey);

        if (existingKey === undefined) {
          byFingerprint.set(fingerprint, withMetadata);
          byFallback.set(fallbackKey, fingerprint);
          continue;
        }

        const existing = byFingerprint.get(existingKey);
        byFingerprint.set(
          existingKey,
          existing === undefined
            ? withMetadata
            : mergeDuplicateFinding(existing, withMetadata)
        );
      }
    }

    const findings = [...byFingerprint.values()];
    const inputFindingLabel = pluralize(inputFindingCount, "finding");
    const sourceLabel = pluralize(sourceCount, "source");
    const uniqueFindingLabel = pluralize(findings.length, "finding");
    return {
      summary:
        `Merged ${inputFindingCount} ${inputFindingLabel} from ${sourceCount} ${sourceLabel} into ${findings.length} unique ${uniqueFindingLabel}.`,
      reviewed_ranges: [...reviewedRangesByKey.values()],
      findings
    };
  }
});

export const validateFindingEvidenceBuiltIn = defineBuiltInStep<
  "findings.validate_evidence",
  FindingsBuiltInDependencies
>({
  name: "findings.validate_evidence",
  async run({ state, input, dependencies = {} }) {
    const validateFindingEvidence =
      dependencies.validateFindingEvidence ?? defaultValidateFindingEvidence;
    const resolved = resolvedInput(input, state);
    const repoContext = requiredInput(
      resolved.repo_context as RepoContext | undefined,
      "repo_context"
    );
    const findingsPayload = requiredInput(resolved.findings, "findings");
    const findings = findingsFrom(findingsPayload);
    const validatedFindings = await validateFindingEvidence(repoContext, findings);

    return {
      ...(typeof findingsPayload === "object" &&
      findingsPayload !== null &&
      !Array.isArray(findingsPayload) &&
      typeof (findingsPayload as FindingsPayload).summary === "string"
        ? { summary: (findingsPayload as FindingsPayload).summary }
        : {}),
      findings: validatedFindings
    };
  }
});
