import type {
  AcceptanceDecision,
  Finding,
  Invocation,
  WorkspaceRecord
} from "./types.js";

const severityRank: Record<Finding["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4
};

type MarkdownOptions = {
  invocation: Invocation;
  findings: readonly Finding[];
  acceptance: AcceptanceDecision;
};

type JsonOptions = {
  acceptance: AcceptanceDecision;
  findings: readonly Finding[];
  reportPath: string;
  workspace?: WorkspaceRecord;
};

export type FinalReportJson = {
  report_path: string;
  acceptance: AcceptanceDecision;
  findings: Finding[];
  workspace?: WorkspaceRecord;
};

function sortFindings(findings: readonly Finding[]): Finding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => {
      const severityDelta =
        severityRank[left.finding.severity] - severityRank[right.finding.severity];

      return severityDelta === 0 ? left.index - right.index : severityDelta;
    })
    .map(({ finding }) => finding);
}

function evidenceLabel(evidence: Finding["evidence"][number]): string {
  return `${evidence.path}:${evidence.line_start}-${evidence.line_end}`;
}

function normalizeMarkdownText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function buildFinalReportMarkdown({
  invocation,
  findings,
  acceptance
}: MarkdownOptions): string {
  const lines = [
    "# Luna Code Review",
    "",
    `PR: ${invocation.owner}/${invocation.repo}#${invocation.pull_number}`,
    `Acceptance: ${acceptance.decision}`,
    "",
    acceptance.summary,
    "",
    "## Findings"
  ];

  const sortedFindings = sortFindings(findings);

  if (sortedFindings.length === 0) {
    lines.push("", "No findings.");
  }

  for (const finding of sortedFindings) {
    lines.push(
      "",
      `### ${finding.severity}: ${normalizeMarkdownText(finding.title)}`,
      "",
      `Confidence: ${finding.confidence}`,
      "",
      normalizeMarkdownText(finding.description),
      "",
      "Evidence:"
    );

    if (finding.evidence.length === 0) {
      lines.push("- None");
    } else {
      for (const evidence of finding.evidence) {
        lines.push(`- ${evidenceLabel(evidence)}`);
      }
    }

    lines.push("", `Recommendation: ${normalizeMarkdownText(finding.recommendation)}`);
  }

  return `${lines.join("\n")}\n`;
}

export function buildFinalReportJson({
  acceptance,
  findings,
  reportPath,
  workspace
}: JsonOptions): FinalReportJson {
  return {
    report_path: reportPath,
    acceptance,
    findings: sortFindings(findings),
    ...(workspace === undefined ? {} : { workspace })
  };
}
