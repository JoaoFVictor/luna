import { describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/core/capabilities/registry.js";
import { capabilityManifest } from "../../src/core/capabilities/manifest.js";
import type { ChangeRequestProviderPort } from "../../src/capabilities/change-request/contracts.js";
import type { PullRequestReviewProviderPort } from "../../src/capabilities/pull-request-review/contracts.js";
import type { AppConfig } from "../../src/core/config/schemas.js";
import {
  assertNativeWorkflowExecutorCoverage,
  buildNativeWorkflowExecutors
} from "../../src/platform/native/native-workflow-executors.js";

const app: AppConfig = {
  workspace: {
    strategy: "git_worktree",
    root: ".runs/workspaces",
    preserve_on_success: true,
    preserve_on_failure: true
  },
  artifacts: { root: ".runs" }
};

describe("native workflow executors", () => {
  it("rejects native executor catalogs that do not cover declared executable capabilities", () => {
    const registry = createCapabilityRegistry([
      capabilityManifest({
        id: "example",
        kind: "execution",
        version: "2026.06.27",
        built_ins: {
          "example.missing": {
            id: "example.missing",
            input_schema: {},
            output_schema: {},
            required_ports: []
          }
        },
        patterns: {
          "example.pattern": {
            id: "example.pattern",
            declaring_node_type: "pattern",
            input_schema: {},
            output_schema: {},
            expand: { type: "declaring_node_subgraph" }
          }
        }
      })
    ]);

    expect(() =>
      assertNativeWorkflowExecutorCoverage({
        builtIns: {},
        patternExecutors: {},
        capabilityRegistry: registry
      })
    ).toThrowError(expect.objectContaining({
      code: "runtime_backend_invalid",
      details: {
        missing_built_ins: ["example.missing"],
        missing_patterns: ["example.pattern"]
      }
    }));
  });

  it("uses injected change-request provider factories instead of a hardcoded provider", async () => {
    const provider: ChangeRequestProviderPort = {
      provider_id: "example",
      readChangeRequest: vi.fn(async () => undefined),
      createChangeRequest: vi.fn<ChangeRequestProviderPort["createChangeRequest"]>(async (input) => ({
        operation_id: "change-request.create",
        enabled: true,
        skipped: false,
        provider: "example",
        provider_id: "example",
        external_id: "cr-1",
        url: "https://example.test/cr-1",
        title: input.title,
        source_branch: input.source_branch,
        target_branch: input.target_branch,
        adopted: false
      }))
    };

    const executors = buildNativeWorkflowExecutors({
      app,
      projectRoot: "/repo",
      run: {
        run_id: "run-1",
        workflow_id: "workflow-1",
        attempt: 1,
        started_at: "2026-06-27T00:00:00.000Z"
      },
      changeRequestProviderFactories: [{
        provider_id: "example",
        createProvider: () => provider
      }]
    });

    await expect(
      executors.builtIns["change-request.create"]({
        node: {
          id: "create_cr",
          kind: "built_in",
          yaml_path: "$.nodes[0]",
          capability_id: "change-request.create",
          output_schema: {},
          can_create_pending_interrupt: false,
          source: {
            id: "create_cr",
            type: "built_in",
            uses: "change-request.create"
          }
        },
        input: {
          provider_id: "example",
          repository_path: "/repo/workspace",
          title: "Implement modular providers",
          source_branch: "task/run-1",
          target_branch: "main"
        },
        state: {
          state_schema_version: "2026-06",
          invocation: {},
          config: {},
          run: {
            run_id: "run-1",
            workflow_id: "workflow-1",
            attempt: 1,
            started_at: "2026-06-27T00:00:00.000Z"
          },
          workflow: { id: "workflow-1", mode: "trusted_local_write" },
          run_status: "running",
          steps: {},
          node_statuses: {},
          attempts: {},
          artifact_refs: [],
          interrupt_refs: [],
          event_cursor: undefined
        },
        runtimeContext: {},
        workflow: {
          id: "workflow-1",
          revision: "rev-1",
          type: "workflow",
          mode: "trusted_local_write",
          directory: "/repo/workflows/workflow-1",
          requires: { repository: false },
          capabilities: [],
          input_schema: "input.schema.json",
          input_schema_content: {},
          output_schema: "output.schema.json",
          output_schema_content: {},
          external_definition_digests: {},
          execution: { max_concurrency: 1 },
          observability: {
            exporters: { runtime_log: { enabled: true, required: false } }
          },
          subagent_policy: { allow_write: false },
          graph: { nodes: [] }
        }
      })
    ).resolves.toMatchObject({
      provider_id: "example",
      external_id: "cr-1"
    });
  });

  it("uses injected pull-request-review provider factories instead of a hardcoded provider", async () => {
    const provider: PullRequestReviewProviderPort = {
      provider_id: "example",
      publishReview: vi.fn<PullRequestReviewProviderPort["publishReview"]>(async (input) => ({
        operation_id: "pull-request-review.publish",
        enabled: true,
        skipped: false,
        provider: "example",
        provider_id: "example",
        external_id: "review-1",
        url: "https://example.test/review-1",
        event: input.event,
        inline_comments: input.comments.length,
        fallback_comments: input.fallback_comments.length
      }))
    };

    const executors = buildNativeWorkflowExecutors({
      app,
      projectRoot: "/repo",
      run: {
        run_id: "run-1",
        workflow_id: "workflow-1",
        attempt: 1,
        started_at: "2026-06-27T00:00:00.000Z"
      },
      pullRequestReviewProviderFactories: [{
        provider_id: "example",
        createProvider: () => provider
      }]
    });

    await expect(
      executors.builtIns["pull-request-review.publish"]({
        node: {
          id: "publish_review",
          kind: "built_in",
          yaml_path: "$.nodes[0]",
          capability_id: "pull-request-review.publish",
          output_schema: {},
          can_create_pending_interrupt: false,
          source: {
            id: "publish_review",
            type: "built_in",
            uses: "pull-request-review.publish"
          }
        },
        input: {
          provider_id: "example",
          repository_path: "/repo/workspace",
          pull_request: {
            owner: "octo-org",
            repo: "hello-world",
            number: 42
          },
          event: "comment",
          body: "Review body",
          findings: { findings: [] },
          repo_context: {
            repository: {
              owner: "octo-org",
              name: "hello-world",
              full_name: "octo-org/hello-world"
            },
            base_sha: "base",
            head_sha: "head",
            files: []
          }
        },
        state: {
          state_schema_version: "2026-06",
          invocation: {},
          config: {},
          run: {
            run_id: "run-1",
            workflow_id: "workflow-1",
            attempt: 1,
            started_at: "2026-06-27T00:00:00.000Z"
          },
          workflow: { id: "workflow-1", mode: "read_only" },
          run_status: "running",
          steps: {},
          node_statuses: {},
          attempts: {},
          artifact_refs: [],
          interrupt_refs: [],
          event_cursor: undefined
        },
        runtimeContext: {},
        workflow: {
          id: "workflow-1",
          revision: "rev-1",
          type: "workflow",
          mode: "read_only",
          directory: "/repo/workflows/workflow-1",
          requires: { repository: false },
          capabilities: [],
          input_schema: "input.schema.json",
          input_schema_content: {},
          output_schema: "output.schema.json",
          output_schema_content: {},
          external_definition_digests: {},
          execution: { max_concurrency: 1 },
          observability: {
            exporters: { runtime_log: { enabled: true, required: false } }
          },
          subagent_policy: { allow_write: false },
          graph: { nodes: [] }
        }
      })
    ).resolves.toMatchObject({
      provider_id: "example",
      external_id: "review-1"
    });
  });
});
