import { describe, expect, it } from "vitest";
import { buildFinalReportMarkdown } from "../../src/providers/github/report-builder.js";
import type { Invocation } from "../../src/core/router/invocation.js";
import type { Finding } from "../../src/core/findings/types.js";
import type { AcceptanceDecision } from "../../src/core/decisions/types.js";

const invocation: Invocation = {
  version: "2026-06",
  source: "github",
  event: "pull_request",
  action: "selected",
  repository: { provider: "github", owner: "octo-org", name: "hello-world" },
  subject: {
    type: "pull_request",
    id: "42",
    url: "https://github.com/octo-org/hello-world/pull/42"
  },
  references: {
    base_ref: "main",
    base_sha: "abc123",
    head_sha: "def456"
  },
  payload: {
    pull_request: { number: 42 },
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
    }
  }
};

const acceptance: AcceptanceDecision = {
  status: "rejected",
  summary: "One blocking issue remains.",
  blocking_reasons: ["Critical issue"],
  recommended_action: "request_changes"
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
  it("normalizes model-controlled Markdown so fields cannot create fake structure", () => {
    const markdown = buildFinalReportMarkdown({
      invocation,
      findings: [
        {
          ...finding("Injected\n## Fake Heading", "high"),
          description: "First line\n### Fake description heading\n- fake list item",
          recommendation: "Fix it\n## Fake recommendation heading\n- fake action"
        }
      ],
      acceptance
    });

    expect(markdown).not.toContain("\n## Fake Heading");
    expect(markdown).not.toContain("\n### Fake description heading");
    expect(markdown).not.toContain("\n## Fake recommendation heading");
    expect(markdown).not.toContain("\n- fake list item");
    expect(markdown).not.toContain("\n- fake action");
    expect(markdown).toContain("Injected ## Fake Heading");
    expect(markdown).toContain("First line ### Fake description heading - fake list item");
    expect(markdown).toContain("Fix it ## Fake recommendation heading - fake action");
  });

  it("normalizes acceptance summary so it cannot create fake structure", () => {
    const markdown = buildFinalReportMarkdown({
      invocation,
      findings: [],
      acceptance: {
        ...acceptance,
        summary: "Summary line\n## Fake acceptance heading\n- fake acceptance item"
      }
    });

    expect(markdown).not.toContain("\n## Fake acceptance heading");
    expect(markdown).not.toContain("\n- fake acceptance item");
    expect(markdown).toContain(
      "Summary line ## Fake acceptance heading - fake acceptance item"
    );
  });
});
