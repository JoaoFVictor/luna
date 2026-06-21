import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { CreatedAgent } from "@flue/runtime";
import type {
  ConfiguredWorkflowRunnerDependencies,
  RunConfiguredWorkflowOptions
} from "../../src/core/configured-workflow-runner.js";
import { gitInvocation } from "../fixtures/git-repo.js";
import {
  cleanupFlueMocks,
  createImplementationSafeGitSkill,
  githubRun,
  importWorkflowWithRunnerMock,
  type InitCall,
  type LocalCall,
  modelProfiles,
  type PromptCall,
  resetEnv
} from "./flue-test-helpers.js";

describe("trusted_host_local Flue agent loop runner", () => {
  beforeEach(() => {
    resetEnv();
  });

  afterEach(() => {
    cleanupFlueMocks();
  });

  it("runs trusted_host_local agent_loop steps with Flue local cwd and env allowlist", async () => {
    process.env.LUNA_ALLOWED_TOKEN = "allowed-secret";
    process.env.LUNA_SECOND_ALLOWED_TOKEN = "second-allowed-secret";
    process.env.LUNA_UNLISTED_TOKEN = "unlisted-secret";
    delete process.env.LUNA_MISSING_TOKEN;

    const localCalls: LocalCall[] = [];
    const promptCalls: PromptCall[] = [];
    const initCalls: InitCall[] = [];
    const runGit = vi.fn(async () => "");
    const validationResult = { passed: true, commands: [] };
    const diffSummary = { files: [] };
    const local = vi.fn((options?: LocalCall) => {
      localCalls.push(options ?? {});
      return { __flueLocalSandbox: true, options };
    });
    const runValidationCommands = vi.fn(async () => validationResult);
    const collectWorktreeDiff = vi.fn(async () => diffSummary);

    vi.doMock("@flue/runtime/node", () => ({ local }));
    vi.doMock("../../src/core/git.js", () => ({ runGit }));
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
    const agentDir = path.join(root, "agents", "code-implementer");
    await mkdir(agentDir, { recursive: true });
    await createImplementationSafeGitSkill(root);

    const instructionsPath = path.join(agentDir, "instructions.md");
    const outputSchemaPath = path.join(agentDir, "output.schema.json");
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
            skills: ["../../skills/implementation-safe-git/SKILL.md"],
            tools: ["repository.status", "repository.diff-summary"],
            directory: agentDir,
            instructionsPath,
            outputSchemaPath
          },
          node: {
            id: "implementation",
            type: "agent_loop",
            agent: "code-implementer",
            output_schema: "implementation_result",
            input: {},
            artifacts: [
              { path: "implementation-attempts.json", source: "$.steps.implementation.attempts", format: "json", required: true },
              { path: "validation.json", source: "$.steps.implementation.validation", format: "json", required: true },
              { path: "implementation-result.json", source: "$.steps.implementation.result", format: "json", required: true }
            ],
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
          model: { model: "openai/implementer-test", reasoning_effort: "high" },
          agentsRoot: path.join(root, "agents"),
          modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
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
        expect(initialized.skills).toHaveLength(1);
        expect(initialized.tools).toHaveLength(2);
        await initialized.tools?.[0]?.execute({});
        await initialized.tools?.[1]?.execute({});

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
    expect(runGit).toHaveBeenNthCalledWith(1, worktreePath, [
      "status",
      "--short"
    ]);
    expect(runGit).toHaveBeenNthCalledWith(2, worktreePath, [
      "diff",
      "--stat"
    ]);
  });

  it("injects resolved subagents into trusted_host_local Flue agent loops", async () => {
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
    const runAgentLoopStateMachine = vi.fn(
      async ({
        dependencies
      }: {
        dependencies: { runWritableAgent(input: unknown): Promise<unknown> };
      }) => {
        await dependencies.runWritableAgent({
          phase: "attempt",
          attempt: 1,
          previousValidation: undefined,
          previousError: undefined,
          diffSummary: undefined
        });

        return { status: "passed" };
      }
    );

    vi.doMock("@flue/runtime/node", () => ({
      local: vi.fn((options?: LocalCall) => ({
        __flueLocalSandbox: true,
        options
      }))
    }));
    vi.doMock("../../src/core/agent-runtime/flue/capabilities.js", () => ({
      resolveFlueAgentCapabilities
    }));
    vi.doMock("../../src/core/agents/loop-runner.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/core/agents/loop-runner.js")>()),
      runAgentLoopStateMachine
    }));

    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-subagents-"));
    const worktreePath = path.join(root, "worktree");
    const agentDir = path.join(root, "agents", "code-implementer");
    await mkdir(agentDir, { recursive: true });
    const instructionsPath = path.join(agentDir, "instructions.md");
    const outputSchemaPath = path.join(agentDir, "output.schema.json");
    await writeFile(instructionsPath, "Implement the requested change.\n");
    await writeFile(
      outputSchemaPath,
      JSON.stringify({ type: "object", additionalProperties: true })
    );

    const runConfiguredWorkflow = vi.fn(
      async (options: RunConfiguredWorkflowOptions) => {
        const runAgentLoopStep =
          options.dependencies?.runAgentLoopStep as NonNullable<
            ConfiguredWorkflowRunnerDependencies["runAgentLoopStep"]
          >;

        return await runAgentLoopStep({
          agent: {
            id: "code-implementer",
            description: "Implement Jira tasks",
            model_profile: "deep",
            mode: "trusted_host_local_write",
            instructions_file: "instructions.md",
            output_schema: "output.schema.json",
            subagents: [{ id: "change-reviewer" }],
            directory: agentDir,
            instructionsPath,
            outputSchemaPath
          },
          node: {
            id: "implementation",
            type: "agent_loop",
            agent: "code-implementer",
            output_schema: "implementation_result",
            input: {},
            artifacts: [{ path: "implementation-result.json", source: "$.steps.implementation.result", format: "json", required: true }],
            sandbox: {
              type: "trusted_host_local",
              cwd: worktreePath,
              env_allowlist: []
            },
            validation: {
              commands: [],
              max_output_bytes: 200000
            },
            repair: { attempts: 0 }
          },
          model: { model: "openai/implementer-test", reasoning_effort: "high" },
          agentsRoot: path.join(root, "agents"),
          modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
          input: { task: "Fix checkout validation" },
          sandbox: {
            type: "trusted_host_local",
            cwd: worktreePath,
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
      init: vi.fn(async (agent: CreatedAgent) => {
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
                status: "implemented",
                summary: "Checkout validation fixed."
              }
            }))
          }))
        };
      })
    } as never);

    expect(resolveFlueAgentCapabilities).toHaveBeenCalledWith({
      agent: expect.objectContaining({ id: "code-implementer" }),
      cwd: worktreePath,
      agentsRoot: path.join(root, "agents"),
      modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
      mcpConfig: { mcp_servers: [] },
      env: process.env
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("resolves trusted_host_local agent_loop capabilities once across repair attempts and closes after completion", async () => {
    const initCalls: InitCall[] = [];
    const validationResults = [
      { passed: false, commands: [] },
      { passed: true, commands: [] }
    ];
    const diffSummary = { files: [] };
    const local = vi.fn((options?: LocalCall) => ({
      __flueLocalSandbox: true,
      options
    }));
    const runValidationCommands = vi.fn(async () => validationResults.shift() ?? {
      passed: true,
      commands: []
    });
    const collectWorktreeDiff = vi.fn(async () => diffSummary);
    const close = vi.fn(async () => {});
    const resolveFlueAgentCapabilities = vi.fn(async () => ({
      skills: [
        {
          name: "implementation-safe-git",
          description: "Keep implementation work scoped and reviewable."
        }
      ],
      tools: [
        {
          name: "repository_status",
          description: "Return short git status.",
          parameters: {},
          execute: async () => ""
        }
      ],
      subagents: [],
      close
    }));

    vi.doMock("@flue/runtime/node", () => ({ local }));
    vi.doMock("../../src/core/agent-runtime/flue/capabilities.js", () => ({
      resolveFlueAgentCapabilities
    }));
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
    const agentDir = path.join(root, "agents", "code-implementer");
    await mkdir(agentDir, { recursive: true });

    const instructionsPath = path.join(agentDir, "instructions.md");
    const outputSchemaPath = path.join(agentDir, "output.schema.json");
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
            skills: ["../../skills/implementation-safe-git/SKILL.md"],
            tools: ["repository.status"],
            directory: agentDir,
            instructionsPath,
            outputSchemaPath
          },
          node: {
            id: "implementation",
            type: "agent_loop",
            agent: "code-implementer",
            output_schema: "implementation_result",
            input: {},
            artifacts: [{ path: "implementation-result.json", source: "$.steps.implementation.result", format: "json", required: true }],
            sandbox: {
              type: "trusted_host_local",
              cwd: worktreePath,
              env_allowlist: []
            },
            validation: {
              commands: [],
              max_output_bytes: 200000
            },
            repair: { attempts: 1 }
          },
          model: { model: "openai/implementer-test", reasoning_effort: "high" },
          agentsRoot: path.join(root, "agents"),
          modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
          input: { task: "Fix checkout validation" },
          sandbox: {
            type: "trusted_host_local",
            cwd: worktreePath,
            env_allowlist: []
          },
          validation: {
            commands: [],
            max_output_bytes: 200000
          },
          repair: { attempts: 1 },
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

    const result = await workflow.run({
      payload: gitInvocation,
      init: vi.fn(async (agent: CreatedAgent, options?: { name?: string }) => {
        initCalls.push({ agent, options });
        const initialized = await agent.initialize({
          id: "test-run",
          payload: gitInvocation,
          env: process.env
        });

        expect(initialized.skills).toHaveLength(1);
        expect(initialized.tools).toHaveLength(1);

        return {
          session: vi.fn(async () => ({
            prompt: vi.fn(async () => ({
              data: {
                status: "implemented",
                summary: "Attempt completed."
              }
            }))
          }))
        };
      })
    } as never);

    expect(result).toMatchObject({
      status: "success",
      output: {
        status: "passed",
        attempts_exhausted: false
      }
    });
    expect(initCalls).toHaveLength(2);
    expect(runValidationCommands).toHaveBeenCalledTimes(2);
    expect(resolveFlueAgentCapabilities).toHaveBeenCalledTimes(1);
    expect(resolveFlueAgentCapabilities).toHaveBeenCalledWith({
      agent: expect.objectContaining({ id: "code-implementer" }),
      cwd: worktreePath,
      agentsRoot: path.join(root, "agents"),
      modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
      mcpConfig: { mcp_servers: [] },
      env: process.env
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes trusted_host_local agent_loop capabilities when the loop rejects", async () => {
    const loopFailure = new Error("loop failed");
    const close = vi.fn(async () => {});
    const resolveFlueAgentCapabilities = vi.fn(async () => ({
      skills: [],
      tools: [],
      subagents: [],
      close
    }));
    const runAgentLoopStateMachine = vi.fn(async () => {
      throw loopFailure;
    });

    vi.doMock("@flue/runtime/node", () => ({ local: vi.fn() }));
    vi.doMock("../../src/core/agent-runtime/flue/capabilities.js", () => ({
      resolveFlueAgentCapabilities
    }));
    vi.doMock("../../src/core/agents/loop-runner.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/core/agents/loop-runner.js")>()),
      runAgentLoopStateMachine
    }));

    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-agent-loop-"));
    const worktreePath = path.join(root, "worktree");
    const agentDir = path.join(root, "agents", "code-implementer");
    await mkdir(agentDir, { recursive: true });

    const instructionsPath = path.join(agentDir, "instructions.md");
    const outputSchemaPath = path.join(agentDir, "output.schema.json");
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

        return await runAgentLoopStep({
          agent: {
            id: "code-implementer",
            description: "Implement Jira tasks",
            model_profile: "deep",
            mode: "trusted_host_local_write",
            instructions_file: "instructions.md",
            output_schema: "output.schema.json",
            directory: agentDir,
            instructionsPath,
            outputSchemaPath
          },
          node: {
            id: "implementation",
            type: "agent_loop",
            agent: "code-implementer",
            output_schema: "implementation_result",
            input: {},
            artifacts: [{ path: "implementation-result.json", source: "$.steps.implementation.result", format: "json", required: true }],
            sandbox: {
              type: "trusted_host_local",
              cwd: worktreePath,
              env_allowlist: []
            },
            validation: {
              commands: [],
              max_output_bytes: 200000
            },
            repair: { attempts: 0 }
          },
          model: { model: "openai/implementer-test", reasoning_effort: "high" },
          agentsRoot: path.join(root, "agents"),
          modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
          input: { task: "Fix checkout validation" },
          sandbox: {
            type: "trusted_host_local",
            cwd: worktreePath,
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

    await expect(workflow.run({ payload: gitInvocation } as never)).rejects.toBe(
      loopFailure
    );

    expect(runAgentLoopStateMachine).toHaveBeenCalledTimes(1);
    expect(resolveFlueAgentCapabilities).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
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
            artifacts: [{ path: "implementation-result.json", source: "$.steps.implementation.result", format: "json", required: true }],
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
          model: { model: "openai/planner-test", reasoning_effort: "medium" },
          agentsRoot: path.join(root, "agents"),
          modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
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
            artifacts: [{ path: "implementation-result.json", source: "$.steps.implementation.result", format: "json", required: true }],
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
          model: { model: "openai/implementer-test", reasoning_effort: "high" },
          agentsRoot: path.join(root, "agents"),
          modelProfiles,
          workflowSubagentPolicy: { allow_write: false },
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

    await expect(workflow.run({ payload: gitInvocation } as never)).rejects.toMatchObject({
      code: "agent_loop_sandbox_unsupported"
    });
    expect(local).not.toHaveBeenCalled();
  });
});
