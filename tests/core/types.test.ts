import { describe, expect, it } from "vitest";
import {
  FileExcerptSchema,
  RepoContextSchema
} from "../../src/core/types.js";
import {
  InvocationSchema,
  RunIdentitySchema,
  RoutingConfigSchema
} from "../../src/core/invocation/types.js";
import {
  AgentLoopResultSchema,
  ValidationResultSchema
} from "../../src/core/agent-runtime/contracts.js";
import {
  GitGateArtifactSchema,
  ImplementationConfigSchema
} from "../../src/core/write-mode/types.js";

const validInvocation = {
  version: "2026-06",
  source: "github",
  event: "pull_request",
  action: "selected",
  repository: {
    provider: "github",
    owner: "octo-org",
    name: "hello-world"
  },
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
    pull_request: {
      number: 42
    }
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
        event: "pull_request",
        action_in: ["opened", "reopened"]
      },
      target: {
        type: "workflow",
        id: "code-review"
      }
    }
  ]
};

const validRunIdentity = {
  run_id:
    "20260618t150405123z-code-review-github-pull-request-octo-org-hello-world-pull-request-42-a1-abcdef123456-n9x8",
  flue_run_id: "flue-run-abcdef123456",
  workflow_id: "code-review",
  attempt: 1,
  source: "github",
  event: "pull_request",
  action: "selected",
  route_target: { type: "workflow", id: "code-review" },
  subject: { type: "pull_request", id: "42" },
  started_at: "2026-06-18T15:04:05.123Z"
};

describe("core zod schemas", () => {
  it("accepts a valid normalized GitHub PR invocation", () => {
    expect(InvocationSchema.parse(validInvocation)).toEqual(validInvocation);
  });

  it("accepts optional subject url and normalized actor fields", () => {
    const invocation = {
      ...validInvocation,
      subject: {
        type: "pull_request",
        id: "42",
        title: "Review normalized input adapters"
      },
      actor: {
        id: "123",
        display_name: "Mona Octocat"
      }
    };

    expect(InvocationSchema.parse(invocation)).toEqual(invocation);
  });

  it("rejects legacy actor fields on invocations", () => {
    expect(() =>
      InvocationSchema.parse({
        ...validInvocation,
        actor: {
          type: "user",
          login: "octocat",
          name: "Mona Octocat",
          email: "mona@example.com"
        }
      })
    ).toThrow();
  });

  it("rejects non-string invocation references", () => {
    expect(() =>
      InvocationSchema.parse({
        ...validInvocation,
        references: {
          base_ref: "main",
          pull_number: 42
        }
      })
    ).toThrow();
  });

  it("rejects empty invocation payload keys", () => {
    expect(() =>
      InvocationSchema.parse({
        ...validInvocation,
        payload: {
          "": {
            number: 42
          }
        }
      })
    ).toThrow();
  });

  it("rejects legacy github_pr invocations", () => {
    expect(() =>
      InvocationSchema.parse({
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
      })
    ).toThrow();
  });

  it("rejects legacy jira_task invocations", () => {
    expect(() =>
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
    ).toThrow();
  });

  it("rejects top-level workflow fields on invocations", () => {
    expect(() =>
      InvocationSchema.parse({
        ...validInvocation,
        workflow: "code-review"
      })
    ).toThrow();
  });

  it("accepts implementation config with structured validation commands", () => {
    expect(
      ImplementationConfigSchema.parse({
        implementation: {
          branch_pattern: "feature/{slug}",
          commit: { enabled: false },
          push: { enabled: false, remote: "origin" },
          change_request: {
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

  it("accepts non-empty change request provider names", () => {
    expect(
      ImplementationConfigSchema.parse({
        implementation: {
          branch_pattern: "feature/{slug}",
          commit: { enabled: false },
          push: { enabled: false, remote: "origin" },
          change_request: {
            enabled: false,
            provider: "unsupported-provider",
            draft: true,
            base_ref: "main"
          },
          sandbox: { type: "trusted_host_local", env_allowlist: [] },
          validation: {
            repair_attempts: 1,
            max_output_bytes: 200000,
            commands: [{ cmd: "npm", args: ["test"] }]
          }
        }
      })
    ).toMatchObject({
      implementation: {
        change_request: {
          provider: "unsupported-provider"
        }
      }
    });

    expect(() =>
      ImplementationConfigSchema.parse({
        implementation: {
          branch_pattern: "feature/{slug}",
          commit: { enabled: false },
          push: { enabled: false, remote: "origin" },
          change_request: {
            enabled: false,
            provider: "",
            draft: true,
            base_ref: "main"
          },
          sandbox: { type: "trusted_host_local", env_allowlist: [] },
          validation: {
            repair_attempts: 1,
            max_output_bytes: 200000,
            commands: [{ cmd: "npm", args: ["test"] }]
          }
        }
      })
    ).toThrow();
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

  it("accepts a run identity with workflow and Flue correlation fields", () => {
    expect(RunIdentitySchema.parse(validRunIdentity)).toEqual(validRunIdentity);
  });

  it("requires the explicit run identity contract fields", () => {
    expect(() =>
      RunIdentitySchema.parse({
        run_id:
          "20260618t150405z-github-pull-request-octo-org-hello-world-pull-request-42-a1",
        attempt: 1,
        source: "github",
        event: "pull_request"
      })
    ).toThrow();
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

  it("accepts a RepoContext containing binary metadata with null patch and excerpt", () => {
    expect(RepoContextSchema.parse(validRepoContext)).toEqual(validRepoContext);
  });

  it("accepts the planned routing config shape", () => {
    expect(RoutingConfigSchema.parse(plannedRoutingConfig)).toEqual(
      plannedRoutingConfig
    );
  });

  it("rejects a route with both event and event_in", () => {
    expect(() =>
      RoutingConfigSchema.parse({
        routes: [
          {
            name: "conflicting-events",
            when: {
              source: "github",
              event: "pull_request",
              event_in: ["issues"]
            },
            target: {
              type: "workflow",
              id: "code-review"
            }
          }
        ]
      })
    ).toThrow();
  });

  it("rejects a route with both action and action_in", () => {
    expect(() =>
      RoutingConfigSchema.parse({
        routes: [
          {
            name: "conflicting-actions",
            when: {
              source: "github",
              event: "pull_request",
              action: "opened",
              action_in: ["reopened"]
            },
            target: {
              type: "workflow",
              id: "code-review"
            }
          }
        ]
      })
    ).toThrow();
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

});
