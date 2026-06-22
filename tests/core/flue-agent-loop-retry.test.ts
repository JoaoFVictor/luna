import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConfiguredWorkflowRunnerDependencies,
  RunConfiguredWorkflowOptions
} from "../../src/core/configured-workflow/runner.js";
import { gitInvocation } from "../fixtures/git-repo.js";
import {
  cleanupFlueMocks,
  githubRun,
  importWorkflowWithRunnerMock,
  modelProfiles,
  resetEnv,
  type LocalCall
} from "./flue-test-helpers.js";

describe("trusted_host_local Flue agent loop retry policy", () => {
  beforeEach(() => {
    resetEnv();
  });

  afterEach(() => {
    cleanupFlueMocks();
  });

  it("does not blindly retry transient trusted_host_local write prompts", async () => {
    const transientFailure = new Error("prompt failed: WebSocket closed 1006");
    const close = vi.fn(async () => {});
    const resolveFlueAgentCapabilities = vi.fn(async () => ({
      skills: [],
      tools: [],
      subagents: [],
      close
    }));
    const runAgentLoopStateMachine = vi.fn(
      async ({
        dependencies
      }: {
        dependencies: {
          runWritableAgent(input: {
            phase: "attempt";
            attempt: number;
            previousValidation?: unknown;
            previousError?: unknown;
            diffSummary?: unknown;
          }): Promise<unknown>;
        };
      }) =>
        await dependencies.runWritableAgent({
          phase: "attempt",
          attempt: 1,
          previousValidation: undefined,
          previousError: undefined,
          diffSummary: undefined
        })
    );
    const prompt = vi.fn().mockRejectedValue(transientFailure);

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

    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-write-no-retry-"));
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
            artifacts: [{
              path: "implementation-result.json",
              source: "$.steps.implementation.result",
              format: "json",
              required: true
            }],
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

    await expect(
      workflow.run({
        payload: gitInvocation,
        init: vi.fn(async () => ({
          session: vi.fn(async () => ({ prompt }))
        }))
      } as never)
    ).rejects.toBe(transientFailure);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe write-mode retry config with an actionable message", async () => {
    const close = vi.fn(async () => {});
    const resolveFlueAgentCapabilities = vi.fn(async () => ({
      skills: [],
      tools: [],
      subagents: [],
      close
    }));
    const runAgentLoopStateMachine = vi.fn(
      async ({
        dependencies
      }: {
        dependencies: {
          runWritableAgent(input: {
            phase: "attempt";
            attempt: number;
            previousValidation?: unknown;
            previousError?: unknown;
            diffSummary?: unknown;
          }): Promise<unknown>;
        };
      }) =>
        await dependencies.runWritableAgent({
          phase: "attempt",
          attempt: 1,
          previousValidation: undefined,
          previousError: undefined,
          diffSummary: undefined
        })
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

    const root = await mkdtemp(path.join(tmpdir(), "luna-flue-write-unsafe-"));
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
            directory: agentDir,
            instructionsPath,
            outputSchemaPath
          },
          node: {
            id: "implementation",
            type: "agent_loop",
            agent: "code-implementer",
            output_schema: "implementation_result",
            retry: { max_attempts: 2 },
            input: {},
            artifacts: [{
              path: "implementation-result.json",
              source: "$.steps.implementation.result",
              format: "json",
              required: true
            }],
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

    const run = workflow.run({ payload: gitInvocation } as never);

    await expect(run).rejects.toMatchObject({
      code: "trusted_host_local_retry_unsafe",
      message: expect.stringContaining(
        "Automatic retry was blocked for a trusted_host_local write agent."
      )
    });
    await expect(run).rejects.toThrow(
      "Inspect the workspace diff/status before rerunning"
    );

    expect(runAgentLoopStateMachine).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
