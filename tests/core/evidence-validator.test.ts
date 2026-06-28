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
  base_sha: "abc123",
  head_sha: "def456",
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
  ]
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
  it("removes evidence when its path is absent from repo context files", () => {
    const [validated] = validateFindingEvidence(repoContext, [
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

    expect(validated.evidence).toEqual([]);
    expect(validated.confidence).toBe("low");
  });

  it("removes evidence when its line range is outside the changed file excerpt", () => {
    const [validated] = validateFindingEvidence(repoContext, [
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

    expect(validated.evidence).toEqual([]);
    expect(validated.confidence).toBe("low");
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
  });

  it("downgrades a high-confidence finding with no valid evidence to low", () => {
    const [validated] = validateFindingEvidence(repoContext, [
      finding({ confidence: "high", evidence: [] })
    ]);

    expect(validated.confidence).toBe("low");
  });

  it("downgrades a medium-confidence finding with no valid evidence to low", () => {
    const [validated] = validateFindingEvidence(repoContext, [
      finding({ confidence: "medium", evidence: [] })
    ]);

    expect(validated.confidence).toBe("low");
  });

  it("keeps a low-confidence finding text when no valid evidence remains", () => {
    const [validated] = validateFindingEvidence(repoContext, [
      finding({
        confidence: "low",
        description: "Keep this weaker signal visible.",
        evidence: []
      })
    ]);

    expect(validated.confidence).toBe("low");
    expect(validated.description).toBe("Keep this weaker signal visible.");
  });

  it("retains valid evidence unchanged", () => {
    const original = finding();

    const [validated] = validateFindingEvidence(repoContext, [original]);

    expect(validated).toEqual(original);
  });
});
