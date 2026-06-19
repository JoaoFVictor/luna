import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatedAgent } from "@flue/runtime";
import type {
  ConfiguredWorkflowRunnerDependencies,
  RunConfiguredWorkflowOptions
} from "../../src/core/configured-workflow-runner.js";
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

function resetEnv(): void {
  process.env = { ...originalEnv };
}

async function importWorkflowWithRunnerMock(
  modulePath: string,
  runConfiguredWorkflow: (options: RunConfiguredWorkflowOptions) => Promise<unknown>
): Promise<{ run: (ctx: never) => Promise<unknown> }> {
  vi.resetModules();
  vi.doMock("../../src/core/configured-workflow-runner.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/core/configured-workflow-runner.js")>()),
    runConfiguredWorkflow
  }));

  return await import(modulePath) as { run: (ctx: never) => Promise<unknown> };
}

describe("flue modules", () => {
  beforeEach(() => {
    resetEnv();
  });

  afterEach(() => {
    vi.doUnmock("../../src/core/configured-workflow-runner.js");
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

  it.each([
    ["luna", "../../src/workflows/luna.js"],
    ["code-review", "../../src/workflows/code-review.js"]
  ])("exports a %s workflow run function", async (_name, modulePath) => {
    const workflow = await importWorkflowWithRunnerMock(modulePath, async () => ({
      status: "success"
    }));

    expect(typeof workflow.run).toBe("function");
  });

  it("runs the generic luna workflow without a default workflow id", async () => {
    const runConfiguredWorkflow = vi.fn(
      async (_options: RunConfiguredWorkflowOptions) => ({ status: "success" })
    );
    const workflow = await importWorkflowWithRunnerMock(
      "../../src/workflows/luna.js",
      runConfiguredWorkflow
    );

    await workflow.run({ payload: gitInvocation } as never);

    expect(runConfiguredWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: gitInvocation,
        configRoot: "config",
        workflowsRoot: "workflows",
        agentsRoot: "agents"
      })
    );
    const options = runConfiguredWorkflow.mock.calls[0]?.[0];
    expect(options).not.toHaveProperty("defaultWorkflowId");
  });

  it("keeps code-review as a compatibility wrapper around the configured runner", async () => {
    const runConfiguredWorkflow = vi.fn(
      async (_options: RunConfiguredWorkflowOptions) => ({ status: "success" })
    );
    const workflow = await importWorkflowWithRunnerMock(
      "../../src/workflows/code-review.js",
      runConfiguredWorkflow
    );

    await workflow.run({ payload: gitInvocation } as never);

    expect(runConfiguredWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: gitInvocation,
        defaultWorkflowId: "code-review",
        configRoot: "config",
        workflowsRoot: "workflows",
        agentsRoot: "agents"
      })
    );
  });

  it("uses Flue context to execute configured agent steps", async () => {
    const promptCalls: PromptCall[] = [];
    const initCalls: InitCall[] = [];
    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-agent-"));
    const instructionsPath = path.join(root, "instructions.md");
    await writeFile(instructionsPath, "Follow the configured instructions.\n");

    const runConfiguredWorkflow = vi.fn(
      async (options: RunConfiguredWorkflowOptions) => {
        const runAgentStep =
          options.dependencies?.runAgentStep as NonNullable<
            ConfiguredWorkflowRunnerDependencies["runAgentStep"]
          >;

        const reviewPlan = await runAgentStep({
          agent: {
            id: "review-planner",
            description: "Plan the review",
            model_profile: "planner",
            mode: "read_only",
            instructions_file: "instructions.md",
            output_schema: "output.schema.json",
            directory: root,
            instructionsPath,
            outputSchemaPath: path.join(root, "output.schema.json")
          },
          node: {
            id: "review_plan",
            type: "agent",
            agent: "review-planner",
            output_schema: "review_plan",
            input: {},
            artifact: "review-plan.json"
          },
          model: { model: "openai/planner-test", thinkingLevel: "medium" },
          input: { repo_context: { files: [] } },
          state: {
            invocation: gitInvocation,
            repository: undefined,
            run: { run_id: "run-1", target: "github_pr" },
            steps: {}
          }
        });

        const findings = await runAgentStep({
          agent: {
            id: "code-reviewer",
            description: "Review code",
            model_profile: "reviewer",
            mode: "read_only",
            instructions_file: "instructions.md",
            output_schema: "output.schema.json",
            directory: root,
            instructionsPath,
            outputSchemaPath: path.join(root, "output.schema.json")
          },
          node: {
            id: "code_review",
            type: "agent",
            agent: "code-reviewer",
            output_schema: "code_review_findings",
            input: {},
            artifact: "code-review-findings.json"
          },
          model: { model: "openai/reviewer-test", thinkingLevel: "high" },
          input: { review_plan: reviewPlan },
          state: {
            invocation: gitInvocation,
            repository: undefined,
            run: { run_id: "run-1", target: "github_pr" },
            steps: { review_plan: reviewPlan }
          }
        });

        const acceptance = await runAgentStep({
          agent: {
            id: "acceptance-reviewer",
            description: "Accept review",
            model_profile: "acceptance",
            mode: "read_only",
            instructions_file: "instructions.md",
            output_schema: "output.schema.json",
            directory: root,
            instructionsPath,
            outputSchemaPath: path.join(root, "output.schema.json")
          },
          node: {
            id: "acceptance",
            type: "agent",
            agent: "acceptance-reviewer",
            output_schema: "acceptance_decision",
            input: {},
            artifact: "acceptance-review.json"
          },
          model: { model: "openai/acceptance-test", thinkingLevel: "low" },
          input: { findings },
          state: {
            invocation: gitInvocation,
            repository: undefined,
            run: { run_id: "run-1", target: "github_pr" },
            steps: { review_plan: reviewPlan, code_review: findings }
          }
        });

        return { status: "success", reviewPlan, findings, acceptance };
      }
    );
    const workflow = await importWorkflowWithRunnerMock(
      "../../src/workflows/luna.js",
      runConfiguredWorkflow
    );

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
    expect(promptCalls[0].text).toContain("repo_context");
    expect(promptCalls[1].text).toContain("review_plan");
    expect(promptCalls[2].text).toContain("findings");
  });
});
