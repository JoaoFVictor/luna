import { describe, expect, it } from "vitest";
import {
  mergeFindingsBuiltIn,
  validateFindingEvidenceBuiltIn
} from "../../../src/capabilities/findings/built-ins.js";
import type { RepoContext } from "../../../src/capabilities/git/diff/types.js";
import type { Finding, FindingsPayload } from "../../../src/core/findings/types.js";
import type { WorkflowState } from "../../../src/core/workflow/state.js";

const state: WorkflowState = {
  invocation: {},
  run: { run_id: "run-1" },
  workflow: { id: "code-review", mode: "read_only" },
  steps: {}
};

function finding({
  title = "Missing null guard",
  severity = "medium",
  confidence = "medium",
  description = "The changed code can dereference a nullable value.",
  recommendation = "Guard the nullable value before use.",
  path = "src/app.ts",
  line = 10,
  quote,
  category
}: {
  readonly title?: string;
  readonly severity?: Finding["severity"];
  readonly confidence?: Finding["confidence"];
  readonly description?: string;
  readonly recommendation?: string;
  readonly path?: string;
  readonly line?: number;
  readonly quote?: string;
  readonly category?: Finding["category"];
} = {}): Finding {
  return {
    title,
    severity,
    confidence,
    description,
    recommendation,
    ...(category === undefined ? {} : { category }),
    evidence: [
      {
        path,
        line_start: line,
        line_end: line,
        ...(quote === undefined ? {} : { quote })
      }
    ]
  };
}

function reviewerResult(findings: readonly Finding[] = []) {
  return {
    reviewed_ranges: [
      { path: "src/app.ts", line_start: 1, line_end: 30 }
    ],
    findings
  };
}

function repoContext(files: RepoContext["files"]): RepoContext {
  const changedFileLimit = Math.max(1, files.length);
  return {
    repository: {
      owner: "octo-org",
      name: "hello-world",
      full_name: "octo-org/hello-world"
    },
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    merge_base: "c".repeat(40),
    files,
    changed_files_truncated: false,
    total_changed_files: files.length,
    changed_file_limit: changedFileLimit,
    changed_files_omitted_count: 0,
    file_excerpts_truncated: files
      .filter((file) => file.excerpt?.truncated === true)
      .map((file) => file.path),
    git: {
      merge_base: "c".repeat(40),
      status_short: [],
      status_short_omitted_count: 0,
      status_short_truncated_count: 0
    }
  };
}

describe("findings capability", () => {
  it("rejects non-canonical repository context before evidence validation", async () => {
    const context = repoContext([]);
    await expect(validateFindingEvidenceBuiltIn.run({
      state,
      input: {
        repo_context: { ...context, unexpected: true },
        findings: { findings: [] }
      }
    })).rejects.toMatchObject({ code: "built_in_input_invalid" });
  });

  it("merges findings from multiple reviewer outputs", () => {
    const result = mergeFindingsBuiltIn.run({
      state,
      input: {
        sources: [
          {
            id: "code_review",
            result: reviewerResult([finding({ title: "Security issue" })])
          },
          {
            id: "architecture_review",
            result: reviewerResult([finding({ title: "Missing test", line: 20 })])
          }
        ]
      }
    });

    expect(result).toEqual({
      summary: "Merged 2 findings from 2 sources into 2 unique findings.",
      reviewed_ranges: [
        { path: "src/app.ts", line_start: 1, line_end: 30 }
      ],
      findings: [
        {
          ...finding({ title: "Security issue" }),
          fingerprint:
            "src/app.ts:10:10|uncategorized|security issue|guard the nullable value before use.",
          sources: ["code_review"],
          merged_from: 1
        },
        {
          ...finding({ title: "Missing test", line: 20 }),
          fingerprint:
            "src/app.ts:20:20|uncategorized|missing test|guard the nullable value before use.",
          sources: ["architecture_review"],
          merged_from: 1
        }
      ]
    });
  });

  it("deduplicates matching findings and keeps the strongest severity and confidence", () => {
    const lowConfidence = finding({
      severity: "medium",
      confidence: "low",
      quote: "dangerous(value)"
    });
    const highConfidence = finding({
      severity: "high",
      confidence: "high",
      quote: "dangerous(value)"
    });

    const result = mergeFindingsBuiltIn.run({
      state,
      input: {
        sources: [
          { id: "code_review", result: reviewerResult([lowConfidence]) },
          { id: "security_review", result: reviewerResult([highConfidence]) }
        ]
      }
    });

    expect(result).toEqual({
      summary: "Merged 2 findings from 2 sources into 1 unique finding.",
      reviewed_ranges: [
        { path: "src/app.ts", line_start: 1, line_end: 30 }
      ],
      findings: [{
        ...highConfidence,
        fingerprint:
          "src/app.ts:10:10|uncategorized|missing null guard|guard the nullable value before use.",
        sources: ["code_review", "security_review"],
        merged_from: 2
      }]
    });
  });

  it("deduplicates cross-category findings when reviewers point at the same primary evidence", () => {
    const bugFinding = finding({
      title: "Global modal state leaks across profile pages",
      category: "bug",
      recommendation: "Move modal state into the composable instance.",
      quote: "const isModalVisible = ref(false);"
    });
    const architectureFinding = finding({
      title: "Shared promo state couples page instances",
      category: "architecture",
      recommendation: "Avoid module-level mutable state for page-specific lifecycle.",
      quote: "const isModalVisible = ref(false);"
    });

    const result = mergeFindingsBuiltIn.run({
      state,
      input: {
        sources: [
          { id: "code_review", result: reviewerResult([bugFinding]) },
          {
            id: "architecture_review",
            result: reviewerResult([architectureFinding])
          }
        ]
      }
    });

    expect(result).toMatchObject({
      summary: "Merged 2 findings from 2 sources into 1 unique finding.",
      findings: [
        {
          category: "bug",
          sources: ["code_review", "architecture_review"],
          merged_from: 2
        }
      ]
    });
  });

  it("rejects unnamed merge sources", () => {
    expect(() =>
      mergeFindingsBuiltIn.run({
        state,
        input: {
          sources: [
            { result: reviewerResult() }
          ]
        }
      })
    ).toThrow("findings.merge source 1 must include a non-empty id.");
  });

  it("rejects merge sources with invalid findings payloads", () => {
    expect(() =>
      mergeFindingsBuiltIn.run({
        state,
        input: {
          sources: [
            {
              id: "code_review",
              result: {
                reviewed_ranges: [
                  { path: "src/app.ts", line_start: 1, line_end: 30 }
                ],
                findings: [
                  {
                    title: "Bad range",
                    severity: "medium",
                    confidence: "medium",
                    description: "Invalid line range.",
                    recommendation: "Return valid evidence.",
                    evidence: [
                      { path: "src/app.ts", line_start: 20, line_end: 10 }
                    ]
                  }
                ]
              }
            }
          ]
        }
      })
    ).toThrow("findings.merge source code_review result must match the findings payload schema.");
  });

  it("rejects reviewer outputs without reviewed ranges", () => {
    expect(() =>
      mergeFindingsBuiltIn.run({
        state,
        input: {
          sources: [
            {
              id: "code_review",
              result: { findings: [] }
            }
          ]
        }
      })
    ).toThrow("findings.merge source code_review result must match the findings payload schema.");
  });

  it("keeps named source provenance and reviewed ranges", () => {
    const result = mergeFindingsBuiltIn.run({
      state,
      input: {
        sources: [
          {
            id: "security_review",
            result: {
              reviewed_ranges: [
                { path: "src/app.ts", line_start: 1, line_end: 20 }
              ],
              findings: [
                finding({
                  title: "Authorization bypass",
                  category: "security"
                })
              ]
            }
          },
          {
            id: "architecture_review",
            result: {
              reviewed_ranges: [
                { path: "src/app.ts", line_start: 1, line_end: 20 }
              ],
              findings: [
                finding({
                  title: "Authorization check is misplaced",
                  category: "security"
                })
              ]
            }
          }
        ]
      }
    });

    expect(result).toMatchObject({
      summary: "Merged 2 findings from 2 sources into 1 unique finding.",
      reviewed_ranges: [
        { path: "src/app.ts", line_start: 1, line_end: 20 }
      ],
      findings: [
        {
          category: "security",
          sources: ["security_review", "architecture_review"],
          merged_from: 2
        }
      ]
    });
  });

  it("keeps evidence on changed patch lines outside a truncated excerpt", async () => {
    const result = await validateFindingEvidenceBuiltIn.run({
      state,
      input: {
        repo_context: repoContext([
          {
            path: "app/pages/profile/[username].vue",
            status: "modified",
            additions: 4,
            deletions: 0,
            patch: [
              "@@ -1208,1 +1210,4 @@",
              " const hasHydrated = ref(false);",
              "+if (val && isHydrated.value) {",
              "+  resumeProfileDwellTracking();",
              "+}"
            ].join("\n"),
            excerpt: {
              start_line: 1,
              end_line: 20,
              content: "<template>\n  <main />\n</template>\n",
              truncated: true
            }
          }
        ]),
        findings: {
          findings: [
            {
              ...finding({
                title: "Repeated tracking resumes",
                path: "app/pages/profile/[username].vue",
                line: 1211
              }),
              fingerprint: "old/path.ts:1:1|bug|stale|fingerprint",
              evidence: [{
                path: "app/pages/profile/[username].vue",
                line_start: 1211,
                line_end: 1212,
                quote: "if (val && isHydrated.value) {\n  resumeProfileDwellTracking();"
              }]
            }
          ]
        }
      }
    }) as FindingsPayload;

    expect(result.findings).toEqual([
      expect.objectContaining({
        title: "Repeated tracking resumes",
        confidence: "medium",
        fingerprint:
          "app/pages/profile/[username].vue:1211:1212|uncategorized|repeated tracking resumes|guard the nullable value before use.",
        evidence: [
          expect.objectContaining({
            path: "app/pages/profile/[username].vue",
            line_start: 1211,
            line_end: 1212,
            quote: "if (val && isHydrated.value) {\n  resumeProfileDwellTracking();"
          })
        ]
      })
    ]);
  });

  it("drops findings whose evidence is not validated against an excerpt or patch", async () => {
    const result = await validateFindingEvidenceBuiltIn.run({
      state,
      input: {
        repo_context: repoContext([
          {
            path: "src/app.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            patch: "@@ -1,1 +1,2 @@\n const ok = true;\n+const changed = true;\n",
            excerpt: {
              start_line: 1,
              end_line: 2,
              content: "const ok = true;\nconst changed = true;\n"
            }
          }
        ]),
        findings: {
          findings: [
            finding({
              title: "Unvalidated concern",
              path: "src/app.ts",
              line: 50
            })
          ]
        }
      }
    }) as FindingsPayload;

    expect(result.findings).toEqual([]);
  });
});
