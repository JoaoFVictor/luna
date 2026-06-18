import { describe, expect, it } from "vitest";
import {
  buildFinalReportJson,
  buildFinalReportMarkdown
} from "../../src/core/report-builder.js";
import type {
  AcceptanceDecision,
  Finding,
  Invocation,
  WorkspaceRecord
} from "../../src/core/types.js";

const invocation: Invocation = {
  target: "github_pr",
  owner: "octo-org",
  repo: "hello-world",
  pull_number: 42,
  base_ref: "main",
  base_repository: {
    owner: "octo-org",
    name: "hello-world",
    full_name: "octo-org/hello-world"
  },
  head_repository: {
    owner: "contributor",
    name: "hello-world",
    full_name: "contributor/hello-world",
    fork: true
  },
  references: {
    base_sha: "abc123",
    head_sha: "def456"
  }
};

const acceptance: AcceptanceDecision = {
  decision: "request_changes",
  summary: "One blocking issue remains.",
  blocking_findings: ["Critical issue"]
};

function finding(title: string, severity: Finding["severity"]): Finding {
  return {
    title,
    severity,
    confidence: "high",
    description: `${title} description.`,
    evidence: [
      {
        path: "src/auth.ts",
        line_start: 11,
        line_end: 12,
        quote: "updateUser(request.body)"
      }
    ],
    recommendation: `${title} recommendation.`
  };
}

describe("final report builder", () => {
  it("includes the PR owner, repo, and number in Markdown", () => {
    const markdown = buildFinalReportMarkdown({
      invocation,
      findings: [],
      acceptance
    });

    expect(markdown).toContain("octo-org/hello-world#42");
  });

  it("groups findings in severity order", () => {
    const markdown = buildFinalReportMarkdown({
      invocation,
      findings: [
        finding("Low issue", "low"),
        finding("Critical issue", "critical"),
        finding("Medium issue", "medium"),
        finding("High issue", "high")
      ],
      acceptance
    });

    expect(markdown.indexOf("Critical issue")).toBeLessThan(
      markdown.indexOf("High issue")
    );
    expect(markdown.indexOf("High issue")).toBeLessThan(
      markdown.indexOf("Medium issue")
    );
    expect(markdown.indexOf("Medium issue")).toBeLessThan(
      markdown.indexOf("Low issue")
    );
  });

  it("renders evidence as path:line-line_end", () => {
    const markdown = buildFinalReportMarkdown({
      invocation,
      findings: [finding("High issue", "high")],
      acceptance
    });

    expect(markdown).toContain("src/auth.ts:11-12");
  });

  it("includes the acceptance verdict in Markdown and JSON", () => {
    const markdown = buildFinalReportMarkdown({
      invocation,
      findings: [],
      acceptance
    });
    const json = buildFinalReportJson({
      acceptance,
      findings: [],
      reportPath: "/tmp/report.md",
      workspace: undefined
    });

    expect(markdown).toContain("request_changes");
    expect(json.acceptance.decision).toBe("request_changes");
  });

  it("uses the final workspace preserved state in JSON", () => {
    const workspace: WorkspaceRecord = {
      run_id: "run-a1",
      path: "/tmp/workspace",
      preserved: true,
      reason: "failure"
    };

    const json = buildFinalReportJson({
      acceptance,
      findings: [],
      reportPath: "/tmp/report.md",
      workspace
    });

    expect(json.workspace).toEqual(workspace);
    expect(json.workspace?.preserved).toBe(true);
  });
});
