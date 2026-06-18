import * as v from "valibot";

const NonEmptyString = v.pipe(v.string(), v.minLength(1));
const PositiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));

export const ReviewPlanResult = v.strictObject({
  summary: NonEmptyString,
  focus_areas: v.array(NonEmptyString),
  files_to_review: v.array(NonEmptyString)
});

const EvidenceRefResult = v.strictObject({
  path: NonEmptyString,
  line_start: PositiveInteger,
  line_end: PositiveInteger,
  quote: v.optional(v.string())
});

const FindingResult = v.strictObject({
  title: NonEmptyString,
  severity: v.picklist(["critical", "high", "medium", "low", "info"]),
  confidence: v.picklist(["high", "medium", "low"]),
  description: NonEmptyString,
  evidence: v.array(EvidenceRefResult),
  recommendation: NonEmptyString
});

export const CodeReviewFindingsResult = v.strictObject({
  findings: v.array(FindingResult),
  summary: v.optional(v.string())
});

export const AcceptanceDecisionResult = v.strictObject({
  decision: v.picklist(["approve", "comment", "request_changes"]),
  summary: NonEmptyString,
  blocking_findings: v.array(NonEmptyString)
});
