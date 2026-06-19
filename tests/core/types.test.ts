import { describe, expect, it } from "vitest";
import {
  AcceptanceDecisionSchema,
  AgentLoopResultSchema,
  AppConfigSchema,
  CodeReviewFindingsSchema,
  EvidenceRefSchema,
  FileExcerptSchema,
  GitGateArtifactSchema,
  ImplementationConfigSchema,
  InvocationSchema,
  ModelsConfigSchema,
  RepositoriesConfigSchema,
  RepoContextSchema,
  ReviewPlanSchema,
  RoutingConfigSchema,
  ValidationResultSchema
} from "../../src/core/types.js";

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
    deep: {
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
    root: ".runs"
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
  status: "rejected",
  summary: "One high-confidence authorization issue remains.",
  blocking_reasons: ["Missing authorization check"],
  recommended_action: "request_changes"
};

describe("core zod schemas", () => {
  it("accepts a valid normalized GitHub PR invocation", () => {
    expect(InvocationSchema.parse(validInvocation)).toEqual(validInvocation);
  });

  it("accepts jira_task invocations", () => {
    expect(
      InvocationSchema.parse({
        target: "jira_task",
        workflow: "implementation",
        jira: {
          instance_id: "company",
          issue_key: "ABC-123",
          url: "https://company.atlassian.net/browse/ABC-123",
          summary: "Fix checkout validation",
          description: "Reject invalid checkout payloads.",
          acceptance_criteria: "Invalid payloads fail validation.",
          status: "To Do",
          issue_type: "Task"
        },
        repository: {
          provider: "github",
          owner: "swinggo-dev",
          name: "swg-front-nuxt"
        }
      })
    ).toMatchObject({ target: "jira_task" });
  });

  it("accepts implementation config with structured validation commands", () => {
    expect(
      ImplementationConfigSchema.parse({
        implementation: {
          branch_pattern: "feature/{slug}",
          commit: { enabled: false },
          push: { enabled: false, remote: "origin" },
          pull_request: {
            enabled: false,
            provider: "github",
            draft: true,
            base_ref: "main"
          },
          sandbox: { type: "trusted_host_local", env_allowlist: [] },
          validation: {
            repair_attempts: 1,
            max_output_bytes: 200000,
            commands: [
              { cmd: "npm", args: ["test"], timeout_ms: 120000 },
              { cmd: "npm", args: ["run", "typecheck"], timeout_ms: 120000 }
            ]
          }
        }
      })
    ).toBeDefined();
  });

  it("accepts implementation runtime result artifacts", () => {
    expect(
      ValidationResultSchema.parse({
        passed: false,
        commands: [
          {
            cmd: "npm",
            args: ["test"],
            exit_code: 1,
            stdout: "",
            stderr: "failed",
            stdout_truncated: false,
            stderr_truncated: false,
            duration_ms: 42,
            timed_out: false
          }
        ]
      })
    ).toMatchObject({ passed: false });

    expect(
      AgentLoopResultSchema.parse({
        status: "failed",
        attempts_exhausted: true,
        attempts: [],
        validation: { passed: false },
        final_validation: { passed: false },
        result: { status: "failed", summary: "Validation failed." }
      })
    ).toMatchObject({ status: "failed" });

    expect(
      GitGateArtifactSchema.parse({
        enabled: true,
        skipped: true,
        reason: "validation_failed"
      })
    ).toMatchObject({ skipped: true });
  });

  it("requires validation and result status on agent loop result artifacts", () => {
    expect(
      AgentLoopResultSchema.parse({
        status: "passed",
        attempts_exhausted: false,
        attempts: [],
        validation: { passed: true },
        final_validation: { passed: true },
        result: { status: "passed", summary: "Validation passed." }
      })
    ).toMatchObject({
      status: "passed",
      validation: { passed: true },
      final_validation: { passed: true }
    });

    expect(() =>
      AgentLoopResultSchema.parse({
        status: "passed",
        attempts_exhausted: false,
        attempts: [],
        final_validation: { passed: true },
        result: { status: "passed", summary: "Validation passed." }
      })
    ).toThrow();

    expect(() =>
      AgentLoopResultSchema.parse({
        status: "passed",
        attempts_exhausted: false,
        attempts: [],
        validation: { passed: true },
        final_validation: { passed: true },
        result: { summary: "Validation passed." }
      })
    ).toThrow();
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
        deep: {
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
        deep: {
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
