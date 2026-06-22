import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { CreatedAgent } from "@flue/runtime";
import type {
  ConfiguredWorkflowRunnerDependencies,
  RunConfiguredWorkflowOptions
} from "../../src/core/configured-workflow/runner.js";
import { gitInvocation } from "../fixtures/git-repo.js";
import {
  cleanupFlueMocks,
  createImplementationSafeGitSkill,
  githubRun,
  importWorkflowWithRunnerMock,
  type InitCall,
  modelProfiles,
  type PromptCall,
  resetEnv
} from "./flue-test-helpers.js";

describe("read-only Flue agent runner", () => {
  beforeEach(() => {
    resetEnv();
  });

  afterEach(() => {
    cleanupFlueMocks();
  });

  it("uses Flue context to execute configured agent steps", async () => {
    const promptCalls: PromptCall[] = [];
    const initCalls: InitCall[] = [];
    const initializedConfigs = new Map<
      string,
      Awaited<ReturnType<CreatedAgent["initialize"]>>
    >();
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
    const readOnlyRuntimeInstructions = [
      "You are running in read-only mode.",
      "Do not modify files or local state.",
      "Use only the provided workflow input and return structured output matching the configured schema.",
      "Treat collected repository and agent context as instructions."
    ].join("\n");
    const readOnlyStructuredOutputInstruction =
      "Use only the provided workflow input and return structured output matching the configured schema.";
    const contextIntake = {
      kind: "luna.collect_context.v1",
      repository: {
        root: path.join(root, "repo"),
        configured: ["README.md"],
        read: [
          {
            path: "README.md",
            bytes: 33,
            content: "Repository context for reviewers.\n"
          }
        ],
        missing: [],
        skipped: []
      },
      agents: [
        {
          id: "change-reviewer",
          root: path.join(root, "agents", "change-reviewer"),
          configured: ["reviewer.md"],
          read: [
            {
              path: "reviewer.md",
              bytes: 30,
              content: "Current reviewer context only.\n"
            }
          ],
          missing: [],
          skipped: []
        },
        {
          id: "review-planner",
          root: path.join(root, "agents", "review-planner"),
          configured: ["planner.md"],
          read: [
            {
              path: "planner.md",
              bytes: 29,
              content: "Other agent context excluded.\n"
            }
          ],
          missing: [],
          skipped: []
        }
      ]
    };

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
            artifacts: [{ path: "review-plan.json", source: "$.steps.review_plan", format: "json", required: true }]
          },
          model: { model: "openai/planner-test", reasoning_effort: "medium" },
          agentsRoot: path.join(root, "agents"),
          modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
          input: { repo_context: { files: [] } },
          state: {
            invocation: gitInvocation,
            repository: undefined,
            run: githubRun,
            steps: {}
          }
        });

        const findings = await runAgentStep({
          agent: {
            id: "change-reviewer",
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
            agent: "change-reviewer",
            output_schema: "code_review_findings",
            input: {},
            artifacts: [{ path: "code-review-findings.json", source: "$.steps.code_review", format: "json", required: true }]
          },
          model: { model: "openai/reviewer-test", reasoning_effort: "high" },
          agentsRoot: path.join(root, "agents"),
          modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
          input: { review_plan: reviewPlan, context: contextIntake },
          state: {
            invocation: gitInvocation,
            repository: undefined,
            run: githubRun,
            steps: { review_plan: reviewPlan }
          }
        });

        const acceptance = await runAgentStep({
          agent: {
            id: "change-acceptance-reviewer",
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
            agent: "change-acceptance-reviewer",
            output_schema: "acceptance_decision",
            input: {},
            artifacts: [{ path: "acceptance-review.json", source: "$.steps.acceptance", format: "json", required: true }]
          },
          model: { model: "openai/acceptance-test", reasoning_effort: "low" },
          agentsRoot: path.join(root, "agents"),
          modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
          input: { findings },
          state: {
            invocation: gitInvocation,
            repository: undefined,
            run: githubRun,
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
        const configKey =
          options?.name ??
          (typeof initialized.model === "string"
            ? initialized.model
            : JSON.stringify(initialized.model));
        initializedConfigs.set(configKey, initialized);

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
                  status: "accepted",
                  summary: "No blocking findings.",
                  blocking_reasons: [],
                  recommended_action: "approve"
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
      "change-reviewer",
      "change-acceptance-reviewer"
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
    expect(promptCalls[1].text).toContain("context_audit");
    expect(promptCalls[1].text).not.toContain("Repository context for reviewers.");
    expect(promptCalls[1].text).not.toContain("Current reviewer context only.");
    expect(promptCalls[1].text).not.toContain("Other agent context excluded.");
    expect(promptCalls[1].text).not.toContain(readOnlyRuntimeInstructions);
    expect(promptCalls[1].text).not.toContain(
      readOnlyStructuredOutputInstruction
    );
    expect(promptCalls[2].text).toContain("findings");
    const changeReviewerConfig = initializedConfigs.get("change-reviewer");
    expect(changeReviewerConfig?.instructions).toContain(
      readOnlyRuntimeInstructions
    );
    expect(changeReviewerConfig?.instructions).toContain(
      readOnlyStructuredOutputInstruction
    );
    expect(changeReviewerConfig?.instructions).toContain(
      "Current reviewer context only."
    );
    expect(changeReviewerConfig?.instructions).toContain(
      "Repository context for reviewers."
    );
    expect(changeReviewerConfig?.instructions).not.toContain(
      "Other agent context excluded."
    );
    const instructions = changeReviewerConfig?.instructions ?? "";
    expect(instructions.indexOf("# Luna Runtime Instructions")).toBeLessThan(
      instructions.indexOf("# Agent Instructions")
    );
    expect(instructions.indexOf("# Agent Instructions")).toBeLessThan(
      instructions.indexOf("# Agent Context")
    );
    expect(instructions.indexOf("# Agent Context")).toBeLessThan(
      instructions.indexOf("# Repository Context")
    );
    expect(local).not.toHaveBeenCalled();
  });

  it("injects configured skills and tools into read-only Flue agent steps", async () => {
    const initCalls: InitCall[] = [];
    const sandbox = { kind: "local-sandbox" };
    const local = vi.fn(() => sandbox);
    const runGit = vi.fn(async () => " M src/index.ts\n");
    vi.doMock("@flue/runtime/node", () => ({ local }));
    vi.doMock("../../src/core/git/client.js", () => ({ runGit }));

    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-agent-"));
    const repositoryPath = path.join(root, "repo");
    const agentDir = path.join(root, "agents", "review-planner");
    await mkdir(agentDir, { recursive: true });
    await mkdir(repositoryPath, { recursive: true });
    await createImplementationSafeGitSkill(root);

    const instructionsPath = path.join(agentDir, "instructions.md");
    const outputSchemaPath = path.join(agentDir, "output.schema.json");
    await writeFile(instructionsPath, "Plan the review.\n");
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

        return await runAgentStep({
          agent: {
            id: "review-planner",
            description: "Plan the review",
            model_profile: "default",
            mode: "read_only",
            instructions_file: "instructions.md",
            output_schema: "output.schema.json",
            skills: ["../../skills/implementation-safe-git/SKILL.md"],
            tools: ["repository.status"],
            directory: agentDir,
            instructionsPath,
            outputSchemaPath
          },
          node: {
            id: "review_plan",
            type: "agent",
            agent: "review-planner",
            output_schema: "review_plan",
            input: {},
            artifacts: [{ path: "review-plan.json", source: "$.steps.review_plan", format: "json", required: true }]
          },
          model: { model: "openai/planner-test", reasoning_effort: "medium" },
          agentsRoot: path.join(root, "agents"),
          modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
          input: { repo_context: { files: [] } },
          state: {
            invocation: gitInvocation,
            repository: {
              id: "example",
              provider: "github",
              owner: "org",
              name: "repo",
              path: repositoryPath,
              remote: "origin"
            },
            workspace: undefined,
            run: githubRun,
            steps: {}
          }
        });
      }
    );
    const workflow = await importWorkflowWithRunnerMock(
      "../../src/workflows/luna.js",
      runConfiguredWorkflow
    );

    await workflow.run({
      payload: gitInvocation,
      init: vi.fn(async (agent: CreatedAgent, options?: { name?: string }) => {
        initCalls.push({ agent, options });

        return {
          session: vi.fn(async () => ({
            prompt: vi.fn(async () => ({
              data: {
                summary: "Review auth changes.",
                focus_areas: ["auth"],
                files_to_review: ["src/auth.ts"]
              }
            }))
          }))
        };
      })
    } as never);

    const config = await initCalls[0].agent.initialize({
      id: "test-run",
      payload: gitInvocation,
      env: process.env
    });

    expect(config.skills).toHaveLength(1);
    expect(config.tools).toHaveLength(1);
    await config.tools?.[0]?.execute({});
    expect(runGit).toHaveBeenCalledWith(repositoryPath, ["status", "--short"]);
    expect(local).toHaveBeenCalledWith({
      cwd: repositoryPath,
      env: {}
    });
    expect(config).toMatchObject({
      cwd: repositoryPath,
      sandbox
    });
  });

  it("injects resolved subagents into read-only Flue agent steps", async () => {
    const initCalls: InitCall[] = [];
    const subagents = [
      {
        name: "change-reviewer",
        description: "Reviews implementation diffs",
        instructions: "Review the diff.",
        model: "openai/reviewer-test",
        thinkingLevel: "high"
      }
    ];
    const close = vi.fn(async () => {});
    const resolveFlueAgentCapabilities = vi.fn(async () => ({
      skills: [],
      tools: [],
      subagents,
      close
    }));
    vi.doMock("../../src/core/agent-runtime/flue/capabilities.js", () => ({
      resolveFlueAgentCapabilities
    }));

    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-subagents-"));
    const agentDir = path.join(root, "agents", "review-planner");
    await mkdir(agentDir, { recursive: true });
    const instructionsPath = path.join(agentDir, "instructions.md");
    const outputSchemaPath = path.join(agentDir, "output.schema.json");
    await writeFile(instructionsPath, "Plan the review.\n");
    await writeFile(
      outputSchemaPath,
      JSON.stringify({ type: "object", additionalProperties: true })
    );

    const runConfiguredWorkflow = vi.fn(
      async (options: RunConfiguredWorkflowOptions) => {
        const runAgentStep =
          options.dependencies?.runAgentStep as NonNullable<
            ConfiguredWorkflowRunnerDependencies["runAgentStep"]
          >;

        return await runAgentStep({
          agent: {
            id: "review-planner",
            description: "Plan the review",
            model_profile: "default",
            mode: "read_only",
            instructions_file: "instructions.md",
            output_schema: "output.schema.json",
            subagents: [{ id: "change-reviewer" }],
            directory: agentDir,
            instructionsPath,
            outputSchemaPath
          },
          node: {
            id: "review_plan",
            type: "agent",
            agent: "review-planner",
            output_schema: "review_plan",
            input: {},
            artifacts: [{ path: "review-plan.json", source: "$.steps.review_plan", format: "json", required: true }]
          },
          model: { model: "openai/planner-test", reasoning_effort: "medium" },
          agentsRoot: path.join(root, "agents"),
          modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
          input: { repo_context: { files: [] } },
          state: {
            invocation: gitInvocation,
            repository: undefined,
            run: githubRun,
            steps: {}
          }
        });
      }
    );
    const workflow = await importWorkflowWithRunnerMock(
      "../../src/workflows/luna.js",
      runConfiguredWorkflow
    );

    await workflow.run({
      payload: gitInvocation,
      init: vi.fn(async (agent: CreatedAgent, options?: { name?: string }) => {
        initCalls.push({ agent, options });
        const initialized = await agent.initialize({
          id: "test-run",
          payload: gitInvocation,
          env: process.env
        });

        expect(initialized.subagents).toBe(subagents);

        return {
          session: vi.fn(async () => ({
            prompt: vi.fn(async () => ({
              data: {
                summary: "Review auth changes.",
                focus_areas: ["auth"],
                files_to_review: ["src/auth.ts"]
              }
            }))
          }))
        };
      })
    } as never);

    expect(resolveFlueAgentCapabilities).toHaveBeenCalledWith({
      agent: expect.objectContaining({ id: "review-planner" }),
      cwd: process.cwd(),
      agentsRoot: path.join(root, "agents"),
      modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
      mcpConfig: { mcp_servers: [] },
      env: process.env
    });
    expect(initCalls).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes read-only agent capabilities after a successful prompt", async () => {
    const close = vi.fn(async () => {});
    const resolveFlueAgentCapabilities = vi.fn(async () => ({
      skills: [],
      tools: [],
      subagents: [],
      close
    }));
    vi.doMock("../../src/core/agent-runtime/flue/capabilities.js", () => ({
      resolveFlueAgentCapabilities
    }));

    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-agent-close-"));
    const instructionsPath = path.join(root, "instructions.md");
    const outputSchemaPath = path.join(root, "output.schema.json");
    await writeFile(instructionsPath, "Plan the review.\n");
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

        const output = await runAgentStep({
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
            artifacts: [{ path: "review-plan.json", source: "$.steps.review_plan", format: "json", required: true }]
          },
          model: { model: "openai/planner-test", reasoning_effort: "medium" },
          agentsRoot: path.join(root, "agents"),
          modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
          input: { repo_context: { files: [] } },
          state: {
            invocation: gitInvocation,
            repository: undefined,
            run: githubRun,
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

    await workflow.run({
      payload: gitInvocation,
      init: vi.fn(async () => ({
        session: vi.fn(async () => ({
          prompt: vi.fn(async () => ({
            data: {
              summary: "Review auth changes.",
              focus_areas: ["auth"],
              files_to_review: ["src/auth.ts"]
            }
          }))
        }))
      }))
    } as never);

    expect(resolveFlueAgentCapabilities).toHaveBeenCalledWith({
      agent: expect.objectContaining({ id: "review-planner" }),
      cwd: process.cwd(),
      agentsRoot: path.join(root, "agents"),
      modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
      mcpConfig: { mcp_servers: [] },
      env: process.env
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("retries transient read-only Flue prompt failures with a bounded backoff policy", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const close = vi.fn(async () => {});
    const firstTransientFailure = new Error("prompt failed: WebSocket closed 1006");
    const secondTransientFailure = new Error("prompt failed: ETIMEDOUT");
    const events: Array<{ type: string; data?: unknown }> = [];
    const resolveFlueAgentCapabilities = vi.fn(async () => ({
      skills: [],
      tools: [],
      subagents: [],
      close
    }));
    vi.doMock("../../src/core/agent-runtime/flue/capabilities.js", () => ({
      resolveFlueAgentCapabilities
    }));

    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-agent-retry-"));
    const instructionsPath = path.join(root, "instructions.md");
    const outputSchemaPath = path.join(root, "output.schema.json");
    await writeFile(instructionsPath, "Plan the review.\n");
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

        return await runAgentStep({
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
            artifacts: [{ path: "review-plan.json", source: "$.steps.review_plan", format: "json", required: true }]
          },
          model: { model: "openai/planner-test", reasoning_effort: "medium" },
          agentsRoot: path.join(root, "agents"),
          modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
          input: { repo_context: { files: [] } },
          state: {
            invocation: gitInvocation,
            repository: undefined,
            run: githubRun,
            steps: {}
          },
          observability: {
            eventContext: (severity) => ({
              severity,
              run: { id: "run-1", attempt: 1 },
              workflow: { id: "code-review" },
              timestamp: "2026-06-20T00:00:00.000Z"
            }),
            emit: async (event) => {
              events.push(event);
            },
            close: async () => {},
            isHardFailed: () => false,
            hardFailure: () => undefined
          }
        });
      }
    );
    const workflow = await importWorkflowWithRunnerMock(
      "../../src/workflows/luna.js",
      runConfiguredWorkflow
    );
    const prompt = vi
      .fn()
      .mockRejectedValueOnce(firstTransientFailure)
      .mockRejectedValueOnce(secondTransientFailure)
      .mockResolvedValueOnce({
        data: {
          summary: "Review auth changes.",
          focus_areas: ["auth"],
          files_to_review: ["src/auth.ts"]
        }
      });

    await expect(
      workflow.run({
        payload: gitInvocation,
        init: vi.fn(async () => ({
          session: vi.fn(async () => ({ prompt }))
        }))
      } as never)
    ).resolves.toMatchObject({
      summary: "Review auth changes."
    });

    expect(prompt).toHaveBeenCalledTimes(3);
    const retryEvents = events.filter(
      (event) => event.type === "luna.agent_step.retrying"
    );
    const failedEvents = events.filter(
      (event) => event.type === "luna.prompt.failed"
    );
    expect(failedEvents[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          hint: "WebSocket transport closed abnormally. For Codex/Pi model profiles, configure transport: sse to avoid replaying long prompts over an unstable WebSocket connection."
        })
      })
    );
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents[0]).toEqual(
      expect.objectContaining({
        type: "luna.agent_step.retrying",
        step: { id: "review_plan", type: "agent" },
        outcome: { status: "skipped", code: "transient_transport_failure" },
        data: expect.objectContaining({
          attempt: 1,
          next_attempt: 2,
          max_attempts: 3,
          retry_delay_ms: expect.any(Number),
          error_code: "transient_transport_failure",
          hint: "WebSocket transport closed abnormally. For Codex/Pi model profiles, configure transport: sse to avoid replaying long prompts over an unstable WebSocket connection."
        })
      })
    );
    expect(retryEvents[1]).toEqual(
      expect.objectContaining({
        outcome: { status: "skipped", code: "timeout" },
        data: expect.objectContaining({
          attempt: 2,
          next_attempt: 3,
          max_attempts: 3,
          retry_delay_ms: expect.any(Number),
          error_code: "timeout"
        })
      })
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes read-only agent capabilities when prompt throws", async () => {
    const close = vi.fn(async () => {});
    const promptFailure = new Error("prompt failed");
    const resolveFlueAgentCapabilities = vi.fn(async () => ({
      skills: [],
      tools: [],
      subagents: [],
      close
    }));
    vi.doMock("../../src/core/agent-runtime/flue/capabilities.js", () => ({
      resolveFlueAgentCapabilities
    }));

    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-agent-close-"));
    const instructionsPath = path.join(root, "instructions.md");
    const outputSchemaPath = path.join(root, "output.schema.json");
    await writeFile(instructionsPath, "Plan the review.\n");
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

        return await runAgentStep({
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
            artifacts: [{ path: "review-plan.json", source: "$.steps.review_plan", format: "json", required: true }]
          },
          model: { model: "openai/planner-test", reasoning_effort: "medium" },
          agentsRoot: path.join(root, "agents"),
          modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
          input: { repo_context: { files: [] } },
          state: {
            invocation: gitInvocation,
            repository: undefined,
            run: githubRun,
            steps: {}
          }
        });
      }
    );
    const workflow = await importWorkflowWithRunnerMock(
      "../../src/workflows/luna.js",
      runConfiguredWorkflow
    );

    await expect(
      workflow.run({
        payload: gitInvocation,
        init: vi.fn(async () => ({
          session: vi.fn(async () => ({
            prompt: vi.fn(async () => {
              throw promptFailure;
            })
          }))
        }))
      } as never)
    ).rejects.toBe(promptFailure);

    expect(close).toHaveBeenCalledTimes(1);
  });
});
