import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  AcceptanceDecisionSchema,
  AppConfigSchema,
  CodeReviewFindingsSchema,
  EvidenceRefSchema,
  FileExcerptSchema,
  InvocationSchema,
  ModelsConfigSchema,
  RepositoriesConfigSchema,
  RepoContextSchema,
  ReviewPlanSchema,
  RoutingConfigSchema
} from "../../src/core/types.js";
import {
  AcceptanceDecisionResult,
  CodeReviewFindingsResult,
  ReviewPlanResult
} from "../../src/core/flue-schemas.js";

const validInvocation = {
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

const validRepoContext = {
  repository: {
    owner: "octo-org",
    name: "hello-world",
    full_name: "octo-org/hello-world"
  },
  base_sha: "abc123",
  head_sha: "def456",
  files: [
    {
      path: "src/image.png",
      status: "modified",
      additions: 0,
      deletions: 0,
      binary: true,
      patch: null,
      excerpt: null
    }
  ]
};

const validModelsConfig = {
  model_profiles: {
    reviewer: {
      model: "openai/gpt-5",
      reasoning_effort: "high"
    }
  }
};

const plannedRepositoriesConfig = {
  repositories: [
    {
      id: "example",
      provider: "github",
      owner: "org",
      name: "repo",
      path: "/tmp/luna-example-repo",
      remote: "origin"
    }
  ]
};

const plannedRoutingConfig = {
  routes: [
    {
      name: "explicit-target",
      when: {
        has_target: true
      },
      use_target_from_input: true
    },
    {
      name: "github-pr-code-review",
      when: {
        source: "github",
        event_in: ["pull_request.opened"]
      },
      target: {
        type: "workflow",
        id: "code-review"
      }
    }
  ]
};

const plannedAppConfig = {
  workspace: {
    strategy: "git_worktree",
    root: ".runs/workspaces",
    preserve_on_success: false,
    preserve_on_failure: true
  },
  artifacts: {
    root: ".runs/code-review"
  }
};

const validReviewPlan = {
  summary: "Review the changed authentication flow.",
  focus_areas: ["Input validation", "Authorization checks"],
  files_to_review: ["src/auth.ts"]
};

const validCodeReviewFindings = {
  findings: [
    {
      title: "Missing authorization check",
      severity: "high",
      confidence: "high",
      description: "The update path does not verify ownership.",
      evidence: [
        {
          path: "src/auth.ts",
          line_start: 12,
          line_end: 18,
          quote: "updateUser(request.body)"
        }
      ],
      recommendation: "Verify the caller owns the user record before updating it."
    }
  ]
};

const validAcceptanceDecision = {
  decision: "request_changes",
  summary: "One high-confidence authorization issue remains.",
  blocking_findings: ["Missing authorization check"]
};

describe("core zod schemas", () => {
  it("accepts a valid normalized GitHub PR invocation", () => {
    expect(InvocationSchema.parse(validInvocation)).toEqual(validInvocation);
  });

  it("rejects a GitHub PR invocation when head_sha is missing", () => {
    const invalidInvocation = {
      ...validInvocation,
      references: {
        base_sha: "abc123"
      }
    };

    expect(() => InvocationSchema.parse(invalidInvocation)).toThrow();
  });

  it("rejects a GitHub PR invocation when base_ref is missing", () => {
    const { base_ref: _baseRef, ...invalidInvocation } = validInvocation;

    expect(() => InvocationSchema.parse(invalidInvocation)).toThrow();
  });

  it("accepts a RepoContext containing binary metadata with null patch and excerpt", () => {
    expect(RepoContextSchema.parse(validRepoContext)).toEqual(validRepoContext);
  });

  it("accepts a ModelsConfig profile with model and reasoning_effort", () => {
    expect(ModelsConfigSchema.parse(validModelsConfig)).toEqual(validModelsConfig);
  });

  it("accepts the planned repositories config shape", () => {
    expect(RepositoriesConfigSchema.parse(plannedRepositoriesConfig)).toEqual(
      plannedRepositoriesConfig
    );
  });

  it("accepts the planned models config shape and rejects profiles", () => {
    expect(ModelsConfigSchema.parse(validModelsConfig)).toEqual(validModelsConfig);

    const invalidConfig = {
      profiles: {
        reviewer: {
          model: "openai/gpt-5",
          reasoning_effort: "high"
        }
      }
    };

    expect(() => ModelsConfigSchema.parse(invalidConfig)).toThrow();
  });

  it("accepts the planned routing config shape", () => {
    expect(RoutingConfigSchema.parse(plannedRoutingConfig)).toEqual(
      plannedRoutingConfig
    );
  });

  it("accepts the planned app workspace config shape", () => {
    expect(AppConfigSchema.parse(plannedAppConfig)).toEqual(plannedAppConfig);
  });

  it("rejects a ModelsConfig profile that uses env", () => {
    const invalidConfig = {
      model_profiles: {
        reviewer: {
          env: "OPENAI_MODEL",
          reasoning_effort: "high"
        }
      }
    };

    expect(() => ModelsConfigSchema.parse(invalidConfig)).toThrow();
  });

  it("rejects a finding without confidence", () => {
    const invalidFindings = {
      findings: [
        {
          title: "Missing authorization check",
          severity: "high",
          description: "The update path does not verify ownership.",
          evidence: [
            {
              path: "src/auth.ts",
              line_start: 12,
              line_end: 18
            }
          ],
          recommendation: "Verify the caller owns the user record before updating it."
        }
      ]
    };

    expect(() => CodeReviewFindingsSchema.parse(invalidFindings)).toThrow();
  });

  it("rejects a FileExcerpt range with end_line before start_line", () => {
    expect(() =>
      FileExcerptSchema.parse({
        start_line: 20,
        end_line: 19,
        content: "const result = run();"
      })
    ).toThrow();
  });

  it("rejects an EvidenceRef range with line_end before line_start", () => {
    expect(() =>
      EvidenceRefSchema.parse({
        path: "src/auth.ts",
        line_start: 20,
        line_end: 19
      })
    ).toThrow();
  });

  it("accepts valid ReviewPlan, CodeReviewFindings, and AcceptanceDecision outputs", () => {
    expect(ReviewPlanSchema.parse(validReviewPlan)).toEqual(validReviewPlan);
    expect(CodeReviewFindingsSchema.parse(validCodeReviewFindings)).toEqual(
      validCodeReviewFindings
    );
    expect(AcceptanceDecisionSchema.parse(validAcceptanceDecision)).toEqual(
      validAcceptanceDecision
    );
  });
});

describe("flue valibot result schemas", () => {
  it("accept the same valid node outputs used by zod", () => {
    expect(v.parse(ReviewPlanResult, validReviewPlan)).toEqual(validReviewPlan);
    expect(v.parse(CodeReviewFindingsResult, validCodeReviewFindings)).toEqual(
      validCodeReviewFindings
    );
    expect(v.parse(AcceptanceDecisionResult, validAcceptanceDecision)).toEqual(
      validAcceptanceDecision
    );
  });

  it("reject invalid evidence ranges", () => {
    const invalidFindings = {
      findings: [
        {
          title: "Missing authorization check",
          severity: "high",
          confidence: "high",
          description: "The update path does not verify ownership.",
          evidence: [
            {
              path: "src/auth.ts",
              line_start: 20,
              line_end: 19
            }
          ],
          recommendation: "Verify the caller owns the user record before updating it."
        }
      ]
    };

    expect(() => v.parse(CodeReviewFindingsResult, invalidFindings)).toThrow();
  });
});
