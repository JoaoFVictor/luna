import { githubPullRequestContextFrom } from "./pull-request-context.js";
import {
  executionSummaryJson,
  executionSummaryMarkdownLines,
  type ExecutionSummaryJson
} from "../../core/reports/execution-summary.js";
import type { Invocation } from "../../core/router/invocation.js";
import type { WorkspaceRecord } from "../../core/write-mode/types.js";
import type { Finding } from "../../core/findings/types.js";
import type { AcceptanceDecision } from "../../core/decisions/types.js";
import type { ObservabilitySummary } from "../../core/observability/summary.js";

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
  summary?: ObservabilitySummary;
};

type JsonOptions = {
  acceptance: AcceptanceDecision;
  findings: readonly Finding[];
  workspace?: WorkspaceRecord;
  summary?: ObservabilitySummary;
};

export type FinalReportJson = {
  acceptance: AcceptanceDecision;
  findings: Finding[];
  workspace?: WorkspaceRecord;
  execution?: ExecutionSummaryJson;
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

function prActionFromAcceptance(acceptance: AcceptanceDecision): string {
  if (
    acceptance.recommended_action === "approve" ||
    acceptance.recommended_action === "comment" ||
    acceptance.recommended_action === "request_changes"
  ) {
    return acceptance.recommended_action;
  }

  if (acceptance.status === "accepted") {
    return "approve";
  }

  if (acceptance.status === "needs_human_review") {
    return "comment";
  }

  return "request_changes";
}

export function buildFinalReportMarkdown({
  invocation,
  findings,
  acceptance,
  summary
}: MarkdownOptions): string {
  const pullRequest = githubPullRequestContextFrom(invocation);
  const lines = [
    "# Luna Code Review",
    "",
    `PR: ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.pull_number}`,
    `Acceptance: ${prActionFromAcceptance(acceptance)}`,
    `Gate status: ${acceptance.status}`,
    "",
    normalizeMarkdownText(acceptance.summary),
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

  lines.push(...executionSummaryMarkdownLines(summary));

  return `${lines.join("\n")}\n`;
}

export function buildFinalReportJson({
  acceptance,
  findings,
  workspace,
  summary
}: JsonOptions): FinalReportJson {
  const execution = executionSummaryJson(summary);

  return {
    acceptance,
    findings: sortFindings(findings),
    ...(workspace === undefined ? {} : { workspace }),
    ...(execution === undefined ? {} : { execution })
  };
}
