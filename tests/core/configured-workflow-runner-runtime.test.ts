import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runConfiguredWorkflow } from "../../src/core/configured-workflow/runner.js";
import type { LunaEvent } from "../../src/core/observability/events.js";
import type { Invocation } from "../../src/core/invocation/types.js";
import type { WorkspaceRecord } from "../../src/core/types.js";
import {
  acceptedDecision,
  artifactPath,
  deferred,
  githubRun,
  invocation,
  jiraInvocation,
  jiraRun,
  pathExists,
  readJson,
  staticRunIdentity,
  withTimeout,
  writeAgent,
  writeBaseConfig,
  writeFullCodeReviewWorkflow,
  writeImplementationConfig,
  writeImplementationWorkflow,
  writePreflightWorkflow,
  writeReviewPlannerAgent,
  writeWorkflow
} from "./configured-workflow-runner-test-helpers.js";

async function writeToyWorkflow(root: string): Promise<void> {
  await mkdir(path.join(root, "workflows", "toy-review"), { recursive: true });
  await writeFile(
    path.join(root, "routing.yaml"),
    [
      "routes:",
      "  - name: toy-review",
      "    when: {}",
      "    target:",
      "      type: workflow",
      "      id: toy-review",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflows", "toy-review", "workflow.yaml"),
    [
      "id: toy-review",
      "type: workflow",
      "mode: git_managed_read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflows", "toy-review", "graph.yaml"),
    [
      "nodes:",
      "  - id: preflight",
      "    type: built_in",
      "    uses: preflight",
      "    artifacts:",
      "      - path: preflight.json",
      "        source: $.steps.preflight",
      "        format: json",
      "  - id: toy_agent",
      "    type: agent",
      "    agent: review-planner",
      "    output_schema: review_plan",
      "    artifacts:",
      "      - path: toy-agent.json",
      "        source: $.steps.toy_agent",
      "        format: json",
      "    input:",
      "      preflight: $.steps.preflight",
      "    after:",
      "      - preflight",
      ""
    ].join("\n")
  );
}


describe("configured workflow runner", () => {
  it("runs a configured workflow graph and writes artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      const runBuiltInStep = vi.fn(async ({ uses }: { uses: string }) => {
        if (uses === "preflight") {
          return { status: "ok" };
        }

        if (uses === "collect_repo_context") {
          return { files: [] };
        }

        return {};
      });
      const runAgentStep = vi.fn(async ({ input }: { input: unknown }) => ({
        summary: "Plan",
        focus_areas: [],
        files_to_review: [],
        input
      }));

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep,
          runAgentStep
        }
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        throw new Error("Expected success result");
      }
      expect(result.workflow_id).toBe("code-review");
      expect(result.steps.review_plan).toMatchObject({
        summary: "Plan",
        input: { repo_context: { files: [] } }
      });
      expect(runBuiltInStep).toHaveBeenCalledTimes(2);
      expect(runAgentStep).toHaveBeenCalledTimes(1);
      await expect(
        readFile(
          artifactPath(root, "code-review", "run-1", "invocation.json"),
          "utf8"
        )
      ).resolves.toContain('"source": "github"');
      await expect(
        readFile(
          artifactPath(root, "code-review", "run-1", "run.json"),
          "utf8"
        )
      ).resolves.toContain("run-1");
      await expect(
        readFile(
          artifactPath(root, "code-review", "run-1", "review-plan.json"),
          "utf8"
        )
      ).resolves.toContain("Plan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes workflow subagent policy to agent steps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root, [
        "subagent_policy:",
        "  allow_write: true"
      ]);
      await writeReviewPlannerAgent(root);

      const runBuiltInStep = vi.fn(async ({ uses }: { uses: string }) => {
        if (uses === "preflight") {
          return { status: "ok" };
        }

        if (uses === "collect_repo_context") {
          return { files: [] };
        }

        return {};
      });
      const policies: unknown[] = [];
      const runAgentStep = vi.fn(
        async ({
          workflowSubagentPolicy
        }: {
          workflowSubagentPolicy: unknown;
        }) => {
          policies.push(workflowSubagentPolicy);

          return {
            summary: "Plan",
            focus_areas: [],
            files_to_review: []
          };
        }
      );

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep,
          runAgentStep
        }
      });

      expect(result.status).toBe("success");
      expect(policies).toEqual([{ allow_write: true }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes artifacts under the routed workflow id namespace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep: async ({ uses }: { uses: string }) =>
            uses === "collect_repo_context" ? { files: [] } : { status: "ok" },
          runAgentStep: async () => ({
            summary: "Plan",
            focus_areas: [],
            files_to_review: []
          })
        }
      });

      await expect(
        readFile(
          path.join(
            root,
            "artifacts",
            "code-review",
            "run-1",
            "review-plan.json"
          ),
          "utf8"
        )
      ).resolves.toContain("Plan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a new configured workflow without a workflow-specific TypeScript module", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeToyWorkflow(root);
      await writeReviewPlannerAgent(root);

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep: vi.fn(async () => ({ status: "ok" })),
          runAgentStep: vi.fn(async ({ input }: { input: unknown }) => ({
            summary: "Toy workflow executed",
            focus_areas: [],
            files_to_review: [],
            input
          }))
        }
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        throw new Error("Expected success result");
      }
      expect(result.workflow_id).toBe("toy-review");
      expect(result.steps.toy_agent).toMatchObject({
        summary: "Toy workflow executed",
        input: { preflight: { status: "ok" } }
      });
      await expect(
        readFile(
          artifactPath(root, "toy-review", "run-1", "toy-agent.json"),
          "utf8"
        )
      ).resolves.toContain("Toy workflow executed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes agent definition, model options, and resolved input to agent steps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      const repoContext = { files: ["src/index.ts"], summary: "existing" };
      const runAgentStep = vi.fn(async () => ({
        summary: "Plan",
        focus_areas: [],
        files_to_review: []
      }));

      await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        workflowsRoot: path.join(root, "workflows"),
        agentsRoot: path.join(root, "agents"),
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) =>
            uses === "collect_repo_context" ? repoContext : { status: "ok" }
          ),
          runAgentStep
        }
      });

      expect(runAgentStep).toHaveBeenCalledTimes(1);
      expect(runAgentStep).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: expect.objectContaining({
            id: "review-planner",
            model_profile: "default"
          }),
          model: {
            model: "openai-codex/gpt-5.4-mini",
            reasoning_effort: "medium"
          },
          agentsRoot: path.join(root, "agents"),
          modelProfiles: {
            default: {
              model: "openai-codex/gpt-5.4-mini",
              reasoning_effort: "medium"
            }
          },
          input: {
            repo_context: repoContext
          }
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("wraps model_profile_missing when an agent references an unknown model profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);
      await writeFile(
        path.join(root, "models.yaml"),
        [
          "model_profiles:",
          "  deep:",
          "    model: openai-codex/gpt-5.4-mini",
          "    reasoning_effort: medium",
          ""
        ].join("\n")
      );

      await expect(
        runConfiguredWorkflow({
          invocation,
          configRoot: root,
          workflowsRoot: path.join(root, "workflows"),
          agentsRoot: path.join(root, "agents"),
          dependencies: {
            createRunIdentity: staticRunIdentity(githubRun),
            runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) =>
              uses === "collect_repo_context" ? { files: [] } : { status: "ok" }
            ),
            runAgentStep: vi.fn()
          }
        })
      ).rejects.toMatchObject({
        code: "scheduler_step_failed",
        details: {
          step_id: "review_plan",
          cause_code: "model_profile_missing"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps missing workflow configuration to workflow_config_read_failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "missing-workflow");

      await expect(
        runConfiguredWorkflow({
          invocation,
          configRoot: root,
          workflowsRoot: path.join(root, "workflows"),
          dependencies: {
            createRunIdentity: staticRunIdentity(githubRun),
            runBuiltInStep: vi.fn(),
            runAgentStep: vi.fn()
          }
        })
      ).rejects.toMatchObject({ code: "workflow_config_read_failed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns failed result and writes error.json for missing workflow when throwOnError is false", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "missing-workflow");

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        workflowsRoot: path.join(root, "workflows"),
        throwOnError: false,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep: vi.fn(),
          runAgentStep: vi.fn()
        }
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") {
        throw new Error("Expected failed result");
      }
      expect(result.workflow_id).toBe("missing-workflow");
      expect(result.error).toMatchObject({
        code: "workflow_config_read_failed"
      });
      await expect(
        readJson(root, "missing-workflow", "run-1", "error.json")
      ).resolves.toMatchObject({
        code: "workflow_config_read_failed"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes GitHub pull request events through normal routing rules", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "code-review", "real");
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      const untargetedInvocation: Invocation = {
        ...invocation,
        action: "opened"
      };
      delete untargetedInvocation.target;
      const result = await runConfiguredWorkflow({
        invocation: untargetedInvocation,
        configRoot: root,
        workflowsRoot: path.join(root, "workflows"),
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) =>
            uses === "collect_repo_context" ? { files: [] } : { status: "ok" }
          ),
          runAgentStep: vi.fn(async () => ({
            summary: "Plan",
            focus_areas: [],
            files_to_review: []
          }))
        }
      });

      expect(result.status).toBe("success");
      expect(result.workflow_id).toBe("code-review");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed explicit targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "code-review", "real");
      await writeWorkflow(root);

      await expect(
        runConfiguredWorkflow({
          invocation: {
            ...invocation,
            target: { type: "workflow", id: "" }
          } as unknown as Invocation,
          configRoot: root,
          workflowsRoot: path.join(root, "workflows"),
          dependencies: {
            createRunIdentity: staticRunIdentity(githubRun),
            runBuiltInStep: vi.fn(),
            runAgentStep: vi.fn()
          }
        })
      ).rejects.toMatchObject({ code: "invalid_target" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
