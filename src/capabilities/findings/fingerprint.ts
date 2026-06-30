import type { Finding } from "../../core/findings/types.js";

function stableText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function primaryEvidenceKey(finding: Finding): string {
  const firstEvidence = finding.evidence[0];
  if (firstEvidence === undefined) {
    return "no-evidence";
  }

  return [
    firstEvidence.path,
    firstEvidence.line_start,
    firstEvidence.line_end
  ].join(":");
}

export function findingFingerprint(finding: Finding): string {
  return [
    primaryEvidenceKey(finding),
    finding.category ?? "uncategorized",
    stableText(finding.title),
    stableText(finding.recommendation)
  ].join("|");
}
