import { describe, expect, it, vi } from "vitest";
import {
  defaultBuiltInSteps,
  builtInStepNames,
  defaultProviderBuiltInStepRegistry,
  isBuiltInStepName,
  runBuiltInStep
} from "../../src/core/providers/built-ins.js";
import {
  builtInStepNames as metadataBuiltInStepNames,
  createBuiltInStepCatalog
} from "../../src/core/built-ins/catalog.js";
import {
  defineBuiltInRegistry,
  defineBuiltInStep
} from "../../src/core/built-ins/registry.js";
import type { BuiltInStepRunOptions } from "../../src/core/built-ins/types.js";
import { createObservabilitySummary } from "../../src/core/observability/summary.js";
import type { WorkflowState } from "../../src/core/workflow/state.js";

const planeImplementationState: WorkflowState = {
  invocation: {
    version: "2026-06",
    source: "plane",
    event: "issue",
    action: "selected",
    repository: {
      provider: "github",
      owner: "octo-org",
      name: "hello-world"
    },
    subject: {
      type: "plane_issue",
      id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
      url: "https://app.plane.so/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
      title: "Fix checkout validation"
    },
    payload: {
      plane: {
        instance_id: "company",
        workspace_slug: "company",
        project_id: "24f9b7",
        issue_id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
        sequence_id: 42,
        description: "Reject invalid checkout payloads.",
        status: "Backlog",
        priority: "high",
        labels: ["bug"]
      }
    }
  },
  repository: {
    id: "repo",
    provider: "github",
    owner: "octo-org",
    name: "hello-world",
    path: "/repo",
    remote: "origin",
    expected_remote_urls: []
  },
  run: { run_id: "run-123" },
  workspace: {
    run_id: "run-123",
    repository_id: "repo",
    path: "/tmp/worktree",
    remote: "origin",
    base_ref: "main",
    base_sha: "abc123",
    branch: "feature/fix-checkout-validation",
    preserved: true,
    reason: "created"
  },
  config: {
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
        repair_attempts: 0,
        max_output_bytes: 1000,
        commands: []
      }
    }
  },
  steps: {
    implementation: {
      final_validation: {
        passed: true,
        commands: []
      }
    },
    commit: { enabled: false, skipped: true, reason: "disabled" },
    push: { enabled: false, skipped: true, reason: "disabled" },
    change_request: { enabled: false, skipped: true, reason: "disabled" }
  }
};

describe("built-in step registry", () => {
  it("resolves registered built-ins by name", async () => {
    const sampleBuiltIn = defineBuiltInStep({
      name: "sample_step",
      run: async () => ({ status: "ok" })
    });
    const registry = defineBuiltInRegistry([sampleBuiltIn]);

    expect(registry.names).toEqual(["sample_step"]);
    expect(registry.has("sample_step")).toBe(true);
    expect(registry.has("missing_step")).toBe(false);
    await expect(
      registry.require("sample_step").run({ state: {} } as BuiltInStepRunOptions)
    ).resolves.toEqual({ status: "ok" });
  });

  it("throws built_in_unsupported for unknown built-ins", () => {
    const registry = defineBuiltInRegistry([]);

    expect(() => registry.require("missing_step")).toThrow(
      "Unsupported built-in step: missing_step"
    );
    expect(() => registry.require("missing_step")).toThrowError(
      expect.objectContaining({ code: "built_in_unsupported" })
    );
  });

  it("throws when duplicate built-in names are registered", () => {
    const first = defineBuiltInStep({ name: "duplicate_step", run: async () => null });
    const second = defineBuiltInStep({ name: "duplicate_step", run: async () => null });

    expect(() => defineBuiltInRegistry([first, second])).toThrow(
      "Duplicate built-in step: duplicate_step"
    );
    expect(() => defineBuiltInRegistry([first, second])).toThrowError(
      expect.objectContaining({ code: "built_in_duplicate" })
    );
  });

  it("passes observability summary through the built-in catalog", async () => {
    const summary = createObservabilitySummary({
      runId: "run-1",
      workflowId: "code-review"
    });
    const sampleBuiltIn = defineBuiltInStep({
      name: "sample_step",
      run: async ({ observabilitySummary: receivedSummary }) => ({
        same_summary: receivedSummary === summary
      })
    });
    const catalog = createBuiltInStepCatalog([sampleBuiltIn]);

    await expect(
      catalog.runBuiltInStep({
        uses: "sample_step",
        state: { invocation: {}, steps: {} },
        observabilitySummary: summary
      })
    ).resolves.toEqual({ same_summary: true });
  });

  it("exports default built-in names from the catalog", () => {
    expect(builtInStepNames).toEqual([
      "preflight",
      "prepare_worktree",
      "collect_context",
      "collect_repo_context",
      "validate_code_review_findings",
      "final_code_review_report",
      "final_report",
      "local-exec.command.read",
      "local-exec.command.write",
      "repository-workspace.capture",
      "prepare_implementation_worktree",
      "collect_task_context",
      "run_validation_commands",
      "record_implementation_validation",
      "collect_worktree_diff",
      "record_acceptance_decision",
      "commit_changes",
      "push_branch",
      "open_change_request",
      "final_implementation_report"
    ]);
    expect(isBuiltInStepName("preflight")).toBe(true);
    expect(isBuiltInStepName("missing_step")).toBe(false);
    expect(defaultProviderBuiltInStepRegistry.names).toEqual(builtInStepNames);
    expect(Object.isFrozen(defaultBuiltInSteps)).toBe(true);
    expect(Object.isFrozen(builtInStepNames)).toBe(true);
  });

  it("keeps provider runtime names aligned with workflow validation metadata", () => {
    expect(metadataBuiltInStepNames).toEqual(builtInStepNames);
    expect(defaultProviderBuiltInStepRegistry.names).toEqual(
      metadataBuiltInStepNames
    );
  });

  it("keeps built-in metadata immutable in the default catalog", () => {
    const prepareWorktree =
      defaultProviderBuiltInStepRegistry.require("prepare_worktree");
    const finalReport = defaultProviderBuiltInStepRegistry.require(
      "final_code_review_report"
    );

    expect(prepareWorktree.metadata).toEqual({
      capturesWorkspace: true,
      requiresRepository: true,
      locks: [{ resource: "repository", mode: "exclusive" }]
    });
    expect(finalReport.metadata).toEqual({
      deferredLifecycle: "final_report"
    });
    expect(Object.isFrozen(prepareWorktree)).toBe(true);
    expect(Object.isFrozen(prepareWorktree.metadata)).toBe(true);
    expect(Object.isFrozen(prepareWorktree.metadata?.locks)).toBe(true);
    expect(Object.isFrozen(finalReport)).toBe(true);
    expect(Object.isFrozen(finalReport.metadata)).toBe(true);
  });

  it("marks repository-mutating built-ins with repository exclusive locks", () => {
    const lockedNames = defaultProviderBuiltInStepRegistry.names.filter((name) =>
      defaultProviderBuiltInStepRegistry.require(name).metadata?.locks?.some((lock) =>
        lock.resource === "repository" && lock.mode === "exclusive"
      ) === true
    );

    expect(lockedNames).toEqual([
      "prepare_worktree",
      "prepare_implementation_worktree",
      "commit_changes",
      "push_branch",
      "open_change_request"
    ]);

    for (const name of lockedNames) {
      expect(defaultProviderBuiltInStepRegistry.require(name).metadata?.locks).toContainEqual({
        resource: "repository",
        mode: "exclusive"
      });
    }
  });

  it("marks repository-sensitive built-ins with repository requirements", () => {
    const repositoryRequiredNames = defaultProviderBuiltInStepRegistry.names.filter(
      (name) =>
        defaultProviderBuiltInStepRegistry.require(name).metadata
          ?.requiresRepository === true
    );

    expect(repositoryRequiredNames).toEqual([
      "preflight",
      "prepare_worktree",
      "collect_context",
      "collect_repo_context",
      "repository-workspace.capture",
      "prepare_implementation_worktree",
      "commit_changes",
      "push_branch",
      "open_change_request"
    ]);
  });

  it("runs default built-ins through the generic entrypoint", async () => {
    const runPreflight = vi.fn(async () => ({ status: "ok" }));

    await expect(
      runBuiltInStep({
        uses: "preflight",
        state: {
          invocation: {
            version: "2026-06",
            source: "github",
            event: "pull_request",
            action: "selected",
            repository: {
              provider: "github",
              owner: "octo-org",
              name: "hello-world"
            },
            subject: { type: "pull_request", id: "42" },
            references: {
              base_ref: "main",
              base_sha: "base-sha",
              head_sha: "head-sha"
            },
            payload: {
              pull_request: { number: 42 },
              base_repository: {
                owner: "octo-org",
                name: "hello-world",
                full_name: "octo-org/hello-world"
              },
              head_repository: {
                owner: "octo-org",
                name: "hello-world",
                full_name: "octo-org/hello-world"
              }
            }
          },
          repository: {
            id: "repo",
            provider: "github",
            owner: "octo-org",
            name: "hello-world",
            path: "/repo",
            remote: "origin",
            expected_remote_urls: []
          },
          steps: {}
        },
        dependencies: { runPreflight }
      })
    ).resolves.toEqual({ status: "ok" });
  });

  it("dispatches implementation task built-ins for Plane invocations", async () => {
    await expect(
      runBuiltInStep({
        uses: "collect_task_context",
        state: planeImplementationState
      })
    ).resolves.toMatchObject({
      implementation_title: "Plane #42: Fix checkout validation",
      implementation_subject: {
        key: "42",
        title: "Fix checkout validation"
      },
      change_request_body: "Reject invalid checkout payloads.",
      plane: {
        issue_id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
        sequence_id: 42,
        status: "Backlog"
      }
    });

    await expect(
      runBuiltInStep({
        uses: "final_implementation_report",
        state: planeImplementationState
      })
    ).resolves.toMatchObject({
      json: {
        task: {
          provider: "plane",
          key: "42",
          title: "Fix checkout validation",
          status: "Backlog"
        },
        plane: {
          issue_id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984"
        }
      }
    });
  });

  it("dispatches implementation task built-ins for Plane browse invocations", async () => {
    const state: WorkflowState = {
      ...planeImplementationState,
      invocation: {
        ...planeImplementationState.invocation!,
        subject: {
          type: "plane_issue",
          id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
          url: "https://app.plane.so/company/browse/PROJ-42/",
          title: "Fix checkout validation"
        },
        payload: {
          plane: {
            instance_id: "company",
            workspace_slug: "company",
            project_identifier: "PROJ",
            issue_identifier: 42,
            issue_id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
            sequence_id: 42,
            description: "Reject invalid checkout payloads.",
            status: "Backlog",
            priority: "high",
            labels: ["bug"]
          }
        }
      }
    };

    await expect(
      runBuiltInStep({
        uses: "collect_task_context",
        state
      })
    ).resolves.toMatchObject({
      implementation_title: "Plane #PROJ-42: Fix checkout validation",
      implementation_subject: {
        key: "PROJ-42",
        title: "Fix checkout validation"
      },
      plane: {
        issue_id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
        project_identifier: "PROJ",
        issue_identifier: 42,
        status: "Backlog"
      }
    });

    await expect(
      runBuiltInStep({
        uses: "final_implementation_report",
        state
      })
    ).resolves.toMatchObject({
      json: {
        task: {
          provider: "plane",
          key: "PROJ-42"
        },
        plane: {
          project_identifier: "PROJ",
          issue_identifier: 42
        }
      }
    });
  });
});
