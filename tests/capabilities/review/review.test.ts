import { describe, expect, it } from "vitest";
import {
  coverageCheckBuiltIn,
  coveragePlanBuiltIn,
  qualityCheckBuiltIn
} from "../../../src/capabilities/review/built-ins.js";
import type { RepoContext } from "../../../src/capabilities/git/diff/types.js";
import type { WorkflowState } from "../../../src/core/workflow/state.js";

const state: WorkflowState = {
  invocation: {},
  run: { run_id: "run-1" },
  workflow: { id: "code-review", mode: "read_only" },
  steps: {}
};

function repoContext(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    repository: {
      owner: "octo-org",
      name: "hello-world",
      full_name: "octo-org/hello-world"
    },
    base_sha: "base",
    head_sha: "head",
    files: [
      {
        path: "src/app.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: [
          "diff --git a/src/app.ts b/src/app.ts",
          "@@ -8,3 +10,4 @@ export function app() {",
          " context",
          "-old",
          "+new",
          "+added",
          " tail"
        ].join("\n"),
        excerpt: {
          start_line: 1,
          end_line: 40,
          content: "content"
        }
      }
    ],
    ...overrides
  };
}

describe("review capability", () => {
  it("plans review coverage from right-side patch hunks", () => {
    const result = coveragePlanBuiltIn.run({
      state,
      input: { repo_context: repoContext() }
    });

    expect(result).toEqual({
      summary: "Review coverage plan has 1 expected review range.",
      status: "ready",
      expected_review_ranges: [
        {
          path: "src/app.ts",
          line_start: 10,
          line_end: 13
        }
      ],
      blocked_ranges: [],
      totals: {
        changed_files: 1,
        expected_review_ranges: 1,
        blocked_ranges: 0
      }
    });
  });

  it("marks omitted, truncated, and uncaptured changes as blocked coverage", () => {
    const result = coveragePlanBuiltIn.run({
      state,
      input: {
        repo_context: repoContext({
          changed_files_truncated: true,
          total_changed_files: 3,
          files: [
            {
              path: "assets/logo.png",
              status: "modified",
              additions: 0,
              deletions: 0,
              binary: true,
              patch_omitted_reason: "binary",
              patch: null,
              excerpt: null
            },
            {
              path: "src/large.ts",
              status: "modified",
              additions: 20,
              deletions: 1,
              patch_truncated: true,
              patch: "@@ -1,1 +1,2 @@\n+line",
              excerpt: null
            }
          ]
        })
      }
    });

    expect(result).toMatchObject({
      status: "blocked",
      expected_review_ranges: [
        {
          path: "src/large.ts",
          line_start: 1,
          line_end: 2
        }
      ],
      blocked_ranges: [
        {
          path: "assets/logo.png",
          reason: "binary"
        },
        {
          path: "src/large.ts",
          reason: "patch_truncated"
        },
        {
          path: "*",
          reason: "changed_files_truncated"
        }
      ]
    });
  });

  it("checks reviewed ranges against the coverage plan", () => {
    const coveragePlan = {
      summary: "Review coverage plan has 2 expected review ranges.",
      status: "ready" as const,
      expected_review_ranges: [
        { path: "src/app.ts", line_start: 10, line_end: 13 },
        { path: "src/other.ts", line_start: 1, line_end: 5 }
      ],
      blocked_ranges: [],
      totals: {
        changed_files: 2,
        expected_review_ranges: 2,
        blocked_ranges: 0
      }
    };

    const result = coverageCheckBuiltIn.run({
      state,
      input: {
        coverage_plan: coveragePlan,
        review_result: {
          reviewed_ranges: [
            { path: "src/app.ts", line_start: 1, line_end: 20 }
          ]
        }
      }
    });

    expect(result).toMatchObject({
      summary: "Review coverage is partial: 1 expected review range was not reported as reviewed.",
      status: "partial",
      reviewed_ranges: [
        { path: "src/app.ts", line_start: 1, line_end: 20 }
      ],
      missing_review_ranges: [
        { path: "src/other.ts", line_start: 1, line_end: 5 }
      ],
      totals: {
        expected_review_ranges: 2,
        reviewed_ranges: 1,
        missing_review_ranges: 1,
        blocked_ranges: 0
      }
    });
  });

  it("preserves reviewer coverage notes and risk tags", () => {
    const coveragePlan = coveragePlanBuiltIn.run({
      state,
      input: {
        repo_context: repoContext({
          files: [
            {
              path: "src/app.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -1,1 +1,2 @@\n old\n+new\n",
              excerpt: {
                start_line: 1,
                end_line: 2,
                content: "old\nnew\n"
              }
            }
          ]
        })
      }
    });

    const result = coverageCheckBuiltIn.run({
      state,
      input: {
        coverage_plan: coveragePlan,
        review_result: {
          reviewed_ranges: [
            {
              path: "src/app.ts",
              line_start: 1,
              line_end: 2,
              notes: "Checked behavior and existing component reuse.",
              risk_tags: ["correctness", "reuse_existing_components"]
            }
          ]
        }
      }
    });

    expect(result).toMatchObject({
      status: "complete",
      reviewed_ranges: [
        {
          path: "src/app.ts",
          line_start: 1,
          line_end: 2,
          notes: "Checked behavior and existing component reuse.",
          risk_tags: ["correctness", "reuse_existing_components"]
        }
      ]
    });
  });

  it("rejects coverage checks without reviewer ranges", () => {
    const coveragePlan = coveragePlanBuiltIn.run({
      state,
      input: { repo_context: repoContext() }
    });

    expect(() =>
      coverageCheckBuiltIn.run({
        state,
        input: {
          coverage_plan: coveragePlan,
          review_result: {}
        }
      })
    ).toThrow("review.coverage_check review_result must include reviewed_ranges.");
  });

  it("passes review quality when coverage and context are clean", () => {
    const coveragePlan = coveragePlanBuiltIn.run({
      state,
      input: { repo_context: repoContext() }
    });
    const coverage = coverageCheckBuiltIn.run({
      state,
      input: {
        coverage_plan: coveragePlan,
        review_result: {
          reviewed_ranges: [
            {
              path: "src/app.ts",
              line_start: 10,
              line_end: 13,
              notes: "Reviewed behavior and compatibility.",
              risk_tags: ["correctness", "compatibility"]
            }
          ]
        }
      }
    });

    const result = qualityCheckBuiltIn.run({
      state,
      input: {
        coverage,
        findings: { findings: [] }
      }
    });

    expect(result).toEqual({
      summary: "Review quality passed deterministic checks.",
      status: "pass",
      reasons: [],
      signals: {
        coverage_status: "complete",
        related_context_warnings: 0,
        related_context_truncated_paths: 0,
        findings: 0,
        publishable_findings: 0
      }
    });
  });

  it("blocks review quality when coverage is partial", () => {
    const coveragePlan = {
      summary: "Review coverage plan has 2 expected review ranges.",
      status: "ready" as const,
      expected_review_ranges: [
        { path: "src/app.ts", line_start: 10, line_end: 13 },
        { path: "src/other.ts", line_start: 1, line_end: 5 }
      ],
      blocked_ranges: [],
      totals: {
        changed_files: 2,
        expected_review_ranges: 2,
        blocked_ranges: 0
      }
    };
    const coverage = coverageCheckBuiltIn.run({
      state,
      input: {
        coverage_plan: coveragePlan,
        review_result: {
          reviewed_ranges: [
            {
              path: "src/app.ts",
              line_start: 10,
              line_end: 13,
              notes: "Reviewed app change.",
              risk_tags: ["correctness"]
            }
          ]
        }
      }
    });

    const result = qualityCheckBuiltIn.run({
      state,
      input: { coverage }
    });

    expect(result).toMatchObject({
      status: "blocked",
      reasons: [
        {
          code: "coverage_partial",
          severity: "blocking",
          path: "src/other.ts"
        }
      ],
      signals: {
        coverage_status: "partial"
      }
    });
  });

  it("requires human review for weak reviewed range declarations", () => {
    const coveragePlan = coveragePlanBuiltIn.run({
      state,
      input: { repo_context: repoContext() }
    });
    const coverage = coverageCheckBuiltIn.run({
      state,
      input: {
        coverage_plan: coveragePlan,
        review_result: {
          reviewed_ranges: [
            { path: "src/app.ts", line_start: 10, line_end: 13 }
          ]
        }
      }
    });

    const result = qualityCheckBuiltIn.run({
      state,
      input: { coverage }
    });

    expect(result).toMatchObject({
      status: "needs_human_review",
      reasons: [
        {
          code: "weak_reviewed_range",
          severity: "warning",
          path: "src/app.ts"
        }
      ]
    });
  });
});
