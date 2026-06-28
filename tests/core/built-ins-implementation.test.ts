import { describe, expect, it, vi } from "vitest";
import { prepareImplementationWorktreeBuiltIn } from "../../src/capabilities/repository-change/prepare-worktree-built-in.js";
import { recordImplementationValidationBuiltIn } from "../../src/capabilities/repository-change/validation-built-in.js";
import type { Invocation } from "../../src/core/router/invocation.js";
import type { WorkspaceRecord } from "../../src/capabilities/repository-change/types.js";
import type { RepositoryConfig } from "../../src/core/config/schemas.js";
import type {
  ImplementationConfig
} from "../../src/capabilities/repository-change/types.js";
import type { ImplementationWorktreeRecord } from "../../src/capabilities/repository-change/worktree.js";
import type { BuiltInStepRunOptions } from "../../src/core/built-ins/types.js";
import type { WorkflowState } from "../../src/core/workflow/state.js";

const jiraInvocation: Invocation = {
  version: "2026-06",
  source: "jira",
  event: "issue",
  action: "selected",
  repository: {
    provider: "github",
    owner: "octo-org",
    name: "hello-world"
  },
  subject: {
    type: "jira_issue",
    id: "ABC-123",
    url: "https://company.atlassian.net/browse/ABC-123",
    title: "Fix checkout validation"
  },
  payload: {
    jira: {
      instance_id: "company",
      description: "Reject invalid checkout payloads.",
      acceptance_criteria: "Invalid payloads fail validation.",
      status: "To Do",
      issue_type: "Task"
    }
  }
};

const repository: RepositoryConfig = {
  id: "repo",
  provider: "github",
  owner: "octo-org",
  name: "hello-world",
  path: "/repo",
  remote: "origin",
  expected_remote_urls: [
    "git@github.com:octo-org/hello-world.git",
    "https://github.com/octo-org/hello-world.git"
  ]
};

const workspace: WorkspaceRecord = {
  run_id: "run-123",
  path: "/worktree/repo",
  preserved: true,
  reason: "created"
};

const implementationWorkspace: ImplementationWorktreeRecord = {
  ...workspace,
  operation_id: "repository-workspace.capture",
  repository_id: "repo",
  workspace_id: "repo:run-123",
  lifecycle: "active",
  captured_at: "2026-06-25T10:00:00.000Z",
  remote: "origin",
  base_ref: "main",
  base_sha: "abc123",
  branch: "feature/abc-123-fix-checkout-validation"
};

const implementationConfig: ImplementationConfig["implementation"] = {
  branch_pattern: "feature/{slug}",
  commit: {
    enabled: true
  },
  push: {
    enabled: true,
    remote: "origin"
  },
  change_request: {
    enabled: true,
    provider: "github",
    draft: true,
    base_ref: "main"
  },
  sandbox: {
    type: "trusted_host_local",
    env_allowlist: []
  },
  validation: {
    repair_attempts: 1,
    max_output_bytes: 1000,
    commands: [
      {
        cmd: "npm",
        args: ["test"]
      }
    ]
  }
};

function implementationState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    invocation: jiraInvocation,
    repository,
    run: { run_id: "run-123" },
    workspace: implementationWorkspace,
    workspaceRoot: "/tmp/worktrees",
    steps: {},
    config: {
      implementation: implementationConfig
    },
    ...overrides
  };
}

async function runBuiltIn(
  builtIn:
    | { run(options: BuiltInStepRunOptions): unknown }
    | ((options: BuiltInStepRunOptions) => unknown),
  options: BuiltInStepRunOptions
): Promise<unknown> {
  return await Promise.resolve().then(() =>
    typeof builtIn === "function" ? builtIn(options) : builtIn.run(options)
  );
}

describe("implementation built-ins", () => {
  it("runs prepare_implementation_worktree through injected dependencies", async () => {
    const prepareImplementationWorktree = vi.fn(async () => implementationWorkspace);

    await expect(
      prepareImplementationWorktreeBuiltIn.run({
        state: implementationState(),
        input: {
          subject: {
            key: "ABC-123",
            title: "Fix checkout validation"
          }
        },
        dependencies: { prepareImplementationWorktree }
      })
    ).resolves.toEqual(implementationWorkspace);

    expect(prepareImplementationWorktree).toHaveBeenCalledWith({
      subject: {
        key: "ABC-123",
        title: "Fix checkout validation"
      },
      repository,
      workspaceRoot: "/tmp/worktrees",
      runId: "run-123",
      baseRef: "main",
      branchPattern: "feature/{slug}"
    });
  });

  it("records rejected acceptance when the gated implementation worker fails", async () => {
    await expect(
      runBuiltIn(recordImplementationValidationBuiltIn, {
        state: implementationState(),
        input: {
          implementation: {
            status: "failed",
            attempts_exhausted: true,
            attempts: [
              {
                attempt: 1,
                phase: "initial",
                agent_error: {
                  message: "Pi runtime request timed out after 180000ms",
                  code: "runtime_provider_unavailable"
                }
              }
            ],
            validation: { passed: false },
            final_validation: { passed: false },
            gates: [],
            result: {
              status: "failed",
              agent_error: {
                message: "Pi runtime request timed out after 180000ms",
                code: "runtime_provider_unavailable"
              }
            }
          }
        }
      })
    ).resolves.toEqual({
      validation: { passed: false },
      acceptance: {
        status: "rejected",
        summary:
          "Implementation failed before acceptance review: Pi runtime request timed out after 180000ms",
        blocking_reasons: ["Pi runtime request timed out after 180000ms"],
        recommended_action: "stop"
      }
    });
  });

});
