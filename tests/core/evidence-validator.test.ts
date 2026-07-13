import { describe, expect, it } from "vitest";
import { validateFindingEvidence } from "../../src/capabilities/findings/evidence-validator.js";
import type { Finding } from "../../src/core/findings/types.js";
import type { RepoContext } from "../../src/capabilities/git/diff/types.js";

const repoContext: RepoContext = {
  repository: {
    owner: "octo-org",
    name: "hello-world",
    full_name: "octo-org/hello-world"
  },
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  merge_base: "c".repeat(40),
  files: [
    {
      path: "src/auth.ts",
      status: "modified",
      additions: 4,
      deletions: 1,
      patch: "@@ -10,5 +10,7 @@",
      excerpt: {
        start_line: 10,
        end_line: 20,
        content: "10 const user = getUser();\n11 updateUser(request.body);\n12 return user;"
      }
    }
  ],
  changed_files_truncated: false,
  total_changed_files: 1,
  changed_file_limit: 1,
  changed_files_omitted_count: 0,
  file_excerpts_truncated: [],
  git: {
    merge_base: "c".repeat(40),
    status_short: [],
    status_short_omitted_count: 0,
    status_short_truncated_count: 0
  }
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    title: "Missing authorization check",
    severity: "high",
    confidence: "high",
    description: "The update path does not verify ownership.",
    evidence: [
      {
        path: "src/auth.ts",
        line_start: 11,
        line_end: 12,
        quote: "updateUser(request.body)"
      }
    ],
    recommendation: "Verify ownership before updating the user.",
    ...overrides
  };
}

describe("evidence validation", () => {
  it("drops findings when their evidence path is absent from repo context files", () => {
    const validated = validateFindingEvidence(repoContext, [
      finding({
        evidence: [
          {
            path: "src/missing.ts",
            line_start: 1,
            line_end: 1
          }
        ]
      })
    ]);

    expect(validated).toEqual([]);
  });

  it("drops findings when their line range is outside the changed file excerpt and patch", () => {
    const validated = validateFindingEvidence(repoContext, [
      finding({
        evidence: [
          {
            path: "src/auth.ts",
            line_start: 21,
            line_end: 22
          }
        ]
      })
    ]);

    expect(validated).toEqual([]);
  });

  it("keeps line evidence and removes the quote when the quote is absent", () => {
    const [validated] = validateFindingEvidence(repoContext, [
      finding({
        evidence: [
          {
            path: "src/auth.ts",
            line_start: 11,
            line_end: 12,
            quote: "deleteEverything()"
          }
        ]
      })
    ]);

    expect(validated.evidence).toEqual([
      {
        path: "src/auth.ts",
        line_start: 11,
        line_end: 12
      }
    ]);
    expect(validated.confidence).toBe("high");
    expect(validated.fingerprint).toBe(
      "src/auth.ts:11:12|uncategorized|missing authorization check|verify ownership before updating the user."
    );
  });

  it("keeps line evidence and removes the quote when the quote is outside the cited line range", () => {
    const [validated] = validateFindingEvidence(repoContext, [
      finding({
        evidence: [
          {
            path: "src/auth.ts",
            line_start: 12,
            line_end: 12,
            quote: "updateUser(request.body)"
          }
        ]
      })
    ]);

    expect(validated.evidence).toEqual([
      {
        path: "src/auth.ts",
        line_start: 12,
        line_end: 12
      }
    ]);
    expect(validated.confidence).toBe("high");
    expect(validated.fingerprint).toBe(
      "src/auth.ts:12:12|uncategorized|missing authorization check|verify ownership before updating the user."
    );
  });

  it("drops a high-confidence finding with no valid evidence", () => {
    const validated = validateFindingEvidence(repoContext, [
      finding({ confidence: "high", evidence: [] })
    ]);

    expect(validated).toEqual([]);
  });

  it("drops a low-confidence finding with no valid evidence", () => {
    const validated = validateFindingEvidence(repoContext, [
      finding({
        confidence: "low",
        description: "Keep this weaker signal visible.",
        evidence: []
      })
    ]);

    expect(validated).toEqual([]);
  });

  it("retains valid evidence and adds a matching fingerprint", () => {
    const original = finding();

    const [validated] = validateFindingEvidence(repoContext, [original]);

    expect(validated).toEqual({
      ...original,
      fingerprint:
        "src/auth.ts:11:12|uncategorized|missing authorization check|verify ownership before updating the user."
    });
  });
});
