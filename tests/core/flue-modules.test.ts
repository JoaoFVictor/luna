import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatedAgent } from "@flue/runtime";
import {
  AcceptanceDecisionSchema,
  CodeReviewFindingsSchema,
  ReviewPlanSchema,
  type RepoContext
} from "../../src/core/types.js";
import { gitInvocation } from "../fixtures/git-repo.js";

type PromptCall = {
  text: string;
  options: Record<string, unknown>;
};

type InitCall = {
  agent: CreatedAgent;
  options?: { name?: string };
};

const originalEnv = { ...process.env };

async function writeConfigRoot(modelsYaml: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-flue-config-"));

  await writeFile(
    path.join(root, "app.yaml"),
    [
      "workspace:",
      "  strategy: git_worktree",
      "  root: /tmp/luna-flue-workspaces",
      "  preserve_on_success: false",
      "  preserve_on_failure: true",
      "artifacts:",
      "  root: /tmp/luna-flue-artifacts",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "routing.yaml"),
    [
      "routes:",
      "  - name: explicit-target",
      "    when:",
      "      has_target: true",
      "    use_target_from_input: true",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "repositories.yaml"),
    [
      "repositories:",
      "  - id: octo-hello",
      "    provider: github",
      "    owner: octo-org",
      "    name: hello-world",
      "    path: /tmp/luna-flue-repo",
      "    remote: origin",
      ""
    ].join("\n")
  );
  await writeFile(path.join(root, "models.yaml"), modelsYaml);

  return root;
}

function resetEnv(): void {
  process.env = { ...originalEnv };
}

async function importWorkflowWithOrchestratorMock(
  executeCodeReview: (options: {
    dependencies?: {
      collectRepoContext?: (options: unknown) => Promise<unknown>;
      runStructuredNode?: (options: {
        nodeName: string;
        schema: unknown;
        artifactStore: unknown;
        execute: () => Promise<unknown>;
      }) => Promise<unknown>;
    };
    nodes: {
      reviewPlanner: { execute: () => Promise<unknown> };
      codeReviewer: { execute: () => Promise<unknown> };
      acceptanceReviewer: { execute: () => Promise<unknown> };
    };
  }) => Promise<unknown>
): Promise<typeof import("../../src/workflows/code-review.js")> {
  vi.resetModules();
  vi.doMock("../../src/core/code-review-orchestrator.js", () => ({
    executeCodeReview
  }));

  return await import("../../src/workflows/code-review.js");
}

const repoContext: RepoContext = {
  repository: {
    owner: "octo-org",
    name: "hello-world",
    full_name: "octo-org/hello-world"
  },
  base_sha: gitInvocation.references.base_sha,
  head_sha: gitInvocation.references.head_sha,
  files: [
    {
      path: "src/auth.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1 @@\n+export const ok = true;\n",
      excerpt: {
        start_line: 1,
        end_line: 1,
        content: "export const ok = true;\n"
      }
    }
  ]
};

describe("flue modules", () => {
  beforeEach(() => {
    resetEnv();
  });

  afterEach(() => {
    vi.doUnmock("../../src/core/code-review-orchestrator.js");
    vi.doUnmock("../../src/core/repo-context-collector.js");
    vi.resetModules();
    vi.restoreAllMocks();
    resetEnv();
  });

  it.each([
    ["review planner", "../../src/agents/review-planner.js"],
    ["code reviewer", "../../src/agents/code-reviewer.js"],
    ["acceptance reviewer", "../../src/agents/acceptance-reviewer.js"]
  ])("%s default export and description are importable without API keys", async (_name, modulePath) => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PLANNER_MODEL;
    delete process.env.REVIEWER_MODEL;
    delete process.env.ACCEPTANCE_MODEL;

    const mod = (await import(modulePath)) as {
      default?: CreatedAgent;
      description?: unknown;
    };

    expect(mod.default).toMatchObject({ __flueCreatedAgent: true });
    expect(typeof mod.description).toBe("string");
    expect((mod.description as string).trim()).not.toBe("");
  });

  it("exports a workflow run function", async () => {
    const workflow = await importWorkflowWithOrchestratorMock(async () => ({
      status: "success"
    }));

    expect(typeof workflow.run).toBe("function");
  });

  it("reports missing model env values during workflow startup", async () => {
    const configRoot = await writeConfigRoot([
      "model_profiles:",
      "  planner:",
      "    model: ${PLANNER_MODEL}",
      "    reasoning_effort: medium",
      "  reviewer:",
      "    model: reviewer-model",
      "    reasoning_effort: high",
      "  acceptance:",
      "    model: acceptance-model",
      "    reasoning_effort: medium",
      ""
    ].join("\n"));
    process.env.LUNA_CONFIG_ROOT = configRoot;
    delete process.env.PLANNER_MODEL;

    const workflow = await importWorkflowWithOrchestratorMock(async () => {
      throw new Error("executeCodeReview should not run without models");
    });

    await expect(
      workflow.run({ payload: gitInvocation } as never)
    ).rejects.toMatchObject({
      code: "model_env_missing",
      message: "Missing model environment variable PLANNER_MODEL"
    });
  });

  it("reports missing required workflow model profiles before prompting", async () => {
    const configRoot = await writeConfigRoot([
      "model_profiles:",
      "  reviewer:",
      "    model: reviewer-model",
      "    reasoning_effort: high",
      "  acceptance:",
      "    model: acceptance-model",
      "    reasoning_effort: medium",
      ""
    ].join("\n"));
    process.env.LUNA_CONFIG_ROOT = configRoot;

    const workflow = await importWorkflowWithOrchestratorMock(async () => {
      throw new Error("executeCodeReview should not run without model profiles");
    });

    await expect(
      workflow.run({ payload: gitInvocation } as never)
    ).rejects.toMatchObject({
      code: "model_profile_missing",
      message: "Model profile planner is not configured for code-review workflow"
    });
  });

  it("passes resolved model profiles to Flue prompts", async () => {
    const promptCalls: PromptCall[] = [];
    const initCalls: InitCall[] = [];
    const configRoot = await writeConfigRoot([
      "model_profiles:",
      "  planner:",
      "    model: ${PLANNER_MODEL}",
      "    reasoning_effort: medium",
      "  reviewer:",
      "    model: ${REVIEWER_MODEL}",
      "    reasoning_effort: high",
      "  acceptance:",
      "    model: ${ACCEPTANCE_MODEL}",
      "    reasoning_effort: low",
      ""
    ].join("\n"));
    process.env.LUNA_CONFIG_ROOT = configRoot;
    process.env.PLANNER_MODEL = "openai/planner-test";
    process.env.REVIEWER_MODEL = "openai/reviewer-test";
    process.env.ACCEPTANCE_MODEL = "openai/acceptance-test";

    vi.doMock("../../src/core/repo-context-collector.js", () => ({
      collectRepoContext: async () => repoContext
    }));
    const workflow = await importWorkflowWithOrchestratorMock(async (options) => {
      const { dependencies, nodes } = options;
      const artifactStore = {
        writeJsonInDirectory: vi.fn()
      };

      await dependencies?.collectRepoContext?.({});
      const reviewPlan = await dependencies?.runStructuredNode?.({
        nodeName: "review-planner",
        schema: ReviewPlanSchema,
        artifactStore,
        execute: nodes.reviewPlanner.execute
      });
      const findings = await dependencies?.runStructuredNode?.({
        nodeName: "code-reviewer",
        schema: CodeReviewFindingsSchema,
        artifactStore,
        execute: nodes.codeReviewer.execute
      });
      const acceptance = await dependencies?.runStructuredNode?.({
        nodeName: "acceptance-reviewer",
        schema: AcceptanceDecisionSchema,
        artifactStore,
        execute: nodes.acceptanceReviewer.execute
      });

      return {
        status: "success",
        reviewPlan,
        findings,
        acceptance
      };
    });

    const result = await workflow.run({
      payload: gitInvocation,
      init: vi.fn(async (agent: CreatedAgent, options?: { name?: string }) => {
        initCalls.push({ agent, options });
        const initialized = await agent.initialize({
          id: "test-run",
          payload: gitInvocation,
          env: process.env
        });

        return {
          session: vi.fn(async () => ({
            prompt: vi.fn(async (text: string, options: Record<string, unknown>) => {
              promptCalls.push({ text, options });

              if (initialized.model === "openai/planner-test") {
                return {
                  data: {
                    summary: "Review auth changes.",
                    focus_areas: ["auth"],
                    files_to_review: ["src/auth.ts"]
                  }
                };
              }

              if (initialized.model === "openai/reviewer-test") {
                return {
                  data: {
                    findings: [],
                    summary: "No findings."
                  }
                };
              }

              return {
                data: {
                  decision: "approve",
                  summary: "No blocking findings.",
                  blocking_findings: []
                }
              };
            })
          }))
        };
      })
    } as never);

    expect(result).toMatchObject({ status: "success" });
    expect(initCalls.map((call) => call.options?.name)).toEqual([
      "review-planner",
      "code-reviewer",
      "acceptance-reviewer"
    ]);
    expect(promptCalls.map((call) => call.options)).toEqual([
      expect.objectContaining({
        model: "openai/planner-test",
        thinkingLevel: "medium"
      }),
      expect.objectContaining({
        model: "openai/reviewer-test",
        thinkingLevel: "high"
      }),
      expect.objectContaining({
        model: "openai/acceptance-test",
        thinkingLevel: "low"
      })
    ]);
  });
});
