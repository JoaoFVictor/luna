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

type LocalCall = {
  cwd?: string;
  env?: Record<string, string | undefined>;
};

const originalEnv = { ...process.env };

function resetEnv(): void {
  process.env = { ...originalEnv };
}

async function importWorkflowWithRunnerMock(
  modulePath: string,
  runConfiguredWorkflow: (options: RunConfiguredWorkflowOptions) => Promise<unknown>,
  registerConfiguredPiOAuthProviders: () => Promise<void> = async () => {}
): Promise<{ run: (ctx: never) => Promise<unknown> }> {
  vi.resetModules();
  vi.doMock("../../src/core/configured-workflow-runner.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/core/configured-workflow-runner.js")>()),
    runConfiguredWorkflow
  }));
  vi.doMock("../../src/core/pi-auth.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/core/pi-auth.js")>()),
    registerConfiguredPiOAuthProviders
  }));

  return await import(modulePath) as { run: (ctx: never) => Promise<unknown> };
}

describe("flue modules", () => {
  beforeEach(() => {
    resetEnv();
  });

  afterEach(() => {
    vi.doUnmock("../../src/core/configured-workflow-runner.js");
    vi.doUnmock("../../src/core/pi-auth.js");
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
    delete process.env.DEFAULT_MODEL;
    delete process.env.DEEP_MODEL;
    delete process.env.BALANCED_MODEL;

    const mod = (await import(modulePath)) as {
      default?: CreatedAgent;
      description?: unknown;
    };

    expect(mod.default).toMatchObject({ __flueCreatedAgent: true });
    expect(typeof mod.description).toBe("string");
    expect((mod.description as string).trim()).not.toBe("");
  });

  it("exports the luna workflow run function", async () => {
    const workflow = await importWorkflowWithRunnerMock(
      "../../src/workflows/luna.js",
      async () => ({ status: "success" })
    );

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
        configRoot: "config"
      })
    );
  });

  it("registers configured Pi OAuth providers before running workflows", async () => {
    const runConfiguredWorkflow = vi.fn(
      async (_options: RunConfiguredWorkflowOptions) => ({ status: "success" })
    );
    const registerConfiguredPiOAuthProviders = vi.fn(async () => {});
    const workflow = await importWorkflowWithRunnerMock(
      "../../src/workflows/luna.js",
      runConfiguredWorkflow,
      registerConfiguredPiOAuthProviders
    );

    await workflow.run({ payload: gitInvocation } as never);

    expect(registerConfiguredPiOAuthProviders).toHaveBeenCalledWith({
      configRoot: "config"
    });
    expect(runConfiguredWorkflow).toHaveBeenCalled();
  });

  it("uses Flue context to execute configured agent steps", async () => {
    const promptCalls: PromptCall[] = [];
    const initCalls: InitCall[] = [];
    const local = vi.fn();
    vi.doMock("@flue/runtime/node", () => ({ local }));
    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-agent-"));
    const instructionsPath = path.join(root, "instructions.md");
    const outputSchemaPath = path.join(root, "output.schema.json");
    await writeFile(instructionsPath, "Follow the configured instructions.\n");
    await writeFile(
      outputSchemaPath,
      JSON.stringify({
        type: "object",
        additionalProperties: true
      })
    );

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
            model_profile: "default",
            mode: "read_only",
            instructions_file: "instructions.md",
            output_schema: "output.schema.json",
            directory: root,
            instructionsPath,
            outputSchemaPath
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
            model_profile: "deep",
            mode: "read_only",
            instructions_file: "instructions.md",
            output_schema: "output.schema.json",
            directory: root,
            instructionsPath,
            outputSchemaPath
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
            model_profile: "default",
            mode: "read_only",
            instructions_file: "instructions.md",
            output_schema: "output.schema.json",
            directory: root,
            instructionsPath,
            outputSchemaPath
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
    expect(promptCalls[0].text).toContain(
      "Use only the provided workflow input and return structured output matching the configured schema."
    );
    expect(local).not.toHaveBeenCalled();
  });

  it("runs trusted_host_local agent_loop steps with Flue local cwd and env allowlist", async () => {
    process.env.LUNA_ALLOWED_TOKEN = "allowed-secret";
    process.env.LUNA_SECOND_ALLOWED_TOKEN = "second-allowed-secret";
    process.env.LUNA_UNLISTED_TOKEN = "unlisted-secret";
    delete process.env.LUNA_MISSING_TOKEN;

    const localCalls: LocalCall[] = [];
    const promptCalls: PromptCall[] = [];
    const initCalls: InitCall[] = [];
    const validationResult = { passed: true, commands: [] };
    const diffSummary = { files: [] };
    const local = vi.fn((options?: LocalCall) => {
      localCalls.push(options ?? {});
      return { __flueLocalSandbox: true, options };
    });
    const runValidationCommands = vi.fn(async () => validationResult);
    const collectWorktreeDiff = vi.fn(async () => diffSummary);

    vi.doMock("@flue/runtime/node", () => ({ local }));
    vi.doMock("../../src/core/validation-runner.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/core/validation-runner.js")>()),
      runValidationCommands
    }));
    vi.doMock("../../src/core/worktree-diff-collector.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/core/worktree-diff-collector.js")>()),
      collectWorktreeDiff
    }));

    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-agent-loop-"));
    const worktreePath = path.join(root, "worktree");
    const instructionsPath = path.join(root, "instructions.md");
    const outputSchemaPath = path.join(root, "output.schema.json");
    await writeFile(instructionsPath, "Implement the requested change.\n");
    await writeFile(
      outputSchemaPath,
      JSON.stringify({
        type: "object",
        additionalProperties: true
      })
    );

    const runConfiguredWorkflow = vi.fn(
      async (options: RunConfiguredWorkflowOptions) => {
        const runAgentLoopStep =
          options.dependencies?.runAgentLoopStep as NonNullable<
            ConfiguredWorkflowRunnerDependencies["runAgentLoopStep"]
          >;

        const output = await runAgentLoopStep({
          agent: {
            id: "code-implementer",
            description: "Implement Jira tasks",
            model_profile: "deep",
            mode: "trusted_host_local_write",
            instructions_file: "instructions.md",
            output_schema: "output.schema.json",
            directory: root,
            instructionsPath,
            outputSchemaPath
          },
          node: {
            id: "implementation",
            type: "agent_loop",
            agent: "code-implementer",
            output_schema: "implementation_result",
            input: {},
            artifact: {
              attempts: "implementation-attempts.json",
              validation: "validation.json",
              result: "implementation-result.json"
            },
            sandbox: {
              type: "trusted_host_local",
              cwd: worktreePath,
              env_allowlist: [
                "LUNA_ALLOWED_TOKEN",
                "LUNA_SECOND_ALLOWED_TOKEN",
                "LUNA_MISSING_TOKEN"
              ]
            },
            validation: {
              commands: [{ cmd: "npm", args: ["test"], timeout_ms: 120000 }],
              max_output_bytes: 200000
            },
            repair: { attempts: 0 }
          },
          model: { model: "openai/implementer-test", thinkingLevel: "high" },
          input: { task: "Fix checkout validation" },
          sandbox: {
            type: "trusted_host_local",
            cwd: worktreePath,
            env_allowlist: [
              "LUNA_ALLOWED_TOKEN",
              "LUNA_SECOND_ALLOWED_TOKEN",
              "LUNA_MISSING_TOKEN"
            ]
          },
          validation: {
            commands: [{ cmd: "npm", args: ["test"], timeout_ms: 120000 }],
            max_output_bytes: 200000
          },
          repair: { attempts: 0 },
          state: {
            invocation: gitInvocation,
            repository: undefined,
            run: { run_id: "run-1", target: "github_pr" },
            steps: {}
          }
        });

        return { status: "success", output };
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

        expect(initialized).toMatchObject({
          model: "openai/implementer-test",
          sandbox: { __flueLocalSandbox: true }
        });

        return {
          session: vi.fn(async () => ({
            prompt: vi.fn(async (text: string, options: Record<string, unknown>) => {
              promptCalls.push({ text, options });

              return {
                data: {
                  status: "implemented",
                  summary: "Checkout validation fixed."
                }
              };
            })
          }))
        };
      })
    } as never);

    expect(result).toMatchObject({
      status: "success",
      output: {
        status: "passed",
        final_validation: validationResult,
        result: {
          status: "passed",
          agent_output: {
            status: "implemented",
            summary: "Checkout validation fixed."
          },
          diff_summary: diffSummary
        }
      }
    });
    expect(initCalls.map((call) => call.options?.name)).toEqual([
      "code-implementer"
    ]);
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].options).toEqual(
      expect.objectContaining({
        model: "openai/implementer-test",
        thinkingLevel: "high"
      })
    );
    expect(promptCalls[0].text).toContain("Fix checkout validation");
    expect(localCalls).toEqual([
      {
        cwd: worktreePath,
        env: {
          LUNA_ALLOWED_TOKEN: "allowed-secret",
          LUNA_SECOND_ALLOWED_TOKEN: "second-allowed-secret"
        }
      }
    ]);
    expect(runValidationCommands).toHaveBeenCalledWith({
      cwd: worktreePath,
      commands: [{ cmd: "npm", args: ["test"], timeout_ms: 120000 }],
      maxOutputBytes: 200000
    });
    expect(collectWorktreeDiff).toHaveBeenCalledWith({
      cwd: worktreePath,
      maxDiffBytes: 200000
    });
  });

  it("rejects trusted_host_local agent_loop when the agent is not trusted_host_local_write", async () => {
    const local = vi.fn();
    vi.doMock("@flue/runtime/node", () => ({ local }));

    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-agent-loop-"));
    const instructionsPath = path.join(root, "instructions.md");
    const outputSchemaPath = path.join(root, "output.schema.json");
    await writeFile(instructionsPath, "Implement the requested change.\n");
    await writeFile(outputSchemaPath, JSON.stringify({ type: "object" }));

    const runConfiguredWorkflow = vi.fn(
      async (options: RunConfiguredWorkflowOptions) => {
        const runAgentLoopStep =
          options.dependencies?.runAgentLoopStep as NonNullable<
            ConfiguredWorkflowRunnerDependencies["runAgentLoopStep"]
          >;

        await runAgentLoopStep({
          agent: {
            id: "review-planner",
            description: "Plan implementation",
            model_profile: "default",
            mode: "read_only",
            instructions_file: "instructions.md",
            output_schema: "output.schema.json",
            directory: root,
            instructionsPath,
            outputSchemaPath
          },
          node: {
            id: "implementation",
            type: "agent_loop",
            agent: "review-planner",
            output_schema: "implementation_result",
            input: {},
            artifact: { result: "implementation-result.json" },
            sandbox: {
              type: "trusted_host_local",
              cwd: root,
              env_allowlist: []
            },
            validation: {
              commands: [],
              max_output_bytes: 200000
            },
            repair: { attempts: 0 }
          },
          model: { model: "openai/planner-test", thinkingLevel: "medium" },
          input: {},
          sandbox: {
            type: "trusted_host_local",
            cwd: root,
            env_allowlist: []
          },
          validation: {
            commands: [],
            max_output_bytes: 200000
          },
          repair: { attempts: 0 },
          state: {
            invocation: gitInvocation,
            repository: undefined,
            run: { run_id: "run-1", target: "github_pr" },
            steps: {}
          }
        });
      }
    );
    const workflow = await importWorkflowWithRunnerMock(
      "../../src/workflows/luna.js",
      runConfiguredWorkflow
    );

    await expect(workflow.run({ payload: gitInvocation } as never)).rejects.toMatchObject({
      code: "trusted_host_local_agent_mode_required"
    });
    expect(local).not.toHaveBeenCalled();
  });

  it("rejects unsupported agent_loop sandbox types before Flue execution", async () => {
    const local = vi.fn();
    vi.doMock("@flue/runtime/node", () => ({ local }));

    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-agent-loop-"));
    const instructionsPath = path.join(root, "instructions.md");
    const outputSchemaPath = path.join(root, "output.schema.json");
    await writeFile(instructionsPath, "Implement the requested change.\n");
    await writeFile(outputSchemaPath, JSON.stringify({ type: "object" }));

    const runConfiguredWorkflow = vi.fn(
      async (options: RunConfiguredWorkflowOptions) => {
        const runAgentLoopStep =
          options.dependencies?.runAgentLoopStep as NonNullable<
            ConfiguredWorkflowRunnerDependencies["runAgentLoopStep"]
          >;

        await runAgentLoopStep({
          agent: {
            id: "code-implementer",
            description: "Implement Jira tasks",
            model_profile: "deep",
            mode: "trusted_host_local_write",
            instructions_file: "instructions.md",
            output_schema: "output.schema.json",
            directory: root,
            instructionsPath,
            outputSchemaPath
          },
          node: {
            id: "implementation",
            type: "agent_loop",
            agent: "code-implementer",
            output_schema: "implementation_result",
            input: {},
            artifact: { result: "implementation-result.json" },
            sandbox: {
              type: "remote",
              cwd: root,
              env_allowlist: []
            },
            validation: {
              commands: [],
              max_output_bytes: 200000
            },
            repair: { attempts: 0 }
          } as never,
          model: { model: "openai/implementer-test", thinkingLevel: "high" },
          input: {},
          sandbox: {
            type: "remote",
            cwd: root,
            env_allowlist: []
          } as never,
          validation: {
            commands: [],
            max_output_bytes: 200000
          },
          repair: { attempts: 0 },
          state: {
            invocation: gitInvocation,
            repository: undefined,
            run: { run_id: "run-1", target: "github_pr" },
            steps: {}
          }
        });
      }
    );
    const workflow = await importWorkflowWithRunnerMock(
      "../../src/workflows/luna.js",
      runConfiguredWorkflow
    );

    await expect(workflow.run({ payload: gitInvocation } as never)).rejects.toMatchObject({
      code: "agent_loop_sandbox_unsupported"
    });
    expect(local).not.toHaveBeenCalled();
  });
});
