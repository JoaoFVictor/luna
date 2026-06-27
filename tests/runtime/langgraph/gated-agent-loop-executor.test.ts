import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { createObservabilitySummary } from "../../../src/core/observability/summary.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import type { WorkflowDefinition, WorkflowNode } from "../../../src/core/workflow/definition-types.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";
import {
  createSqliteCheckpointStore,
  sqliteCheckpointFile
} from "../../../src/runtime/backends/sqlite/checkpoints.js";
import { createLangGraphCheckpointer } from "../../../src/runtime/backends/sqlite/langgraph-checkpointer.js";
import {
  gatedAgentGateKey,
  gatedAgentWorkerKey
} from "../../../src/runtime/langgraph/gated-agent-loop-keys.js";
import {
  runCompiledWorkflow,
  type WorkflowAgentDefaults
} from "../../../src/runtime/langgraph/workflow-runner.js";

const execFileAsync = promisify(execFile);

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "runtime",
    kind: "execution",
    version: "1.0.0",
    built_ins: {
      "runtime.ok": {
        id: "runtime.ok",
        input_schema: { type: "object" },
        output_schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } }
        },
        required_ports: []
      }
    }
  }),
  capabilityManifest({
    id: "quality-gates",
    kind: "execution",
    version: "1.0.0",
    patterns: {
      "quality-gates.gated_agent_loop": {
        id: "quality-gates.gated_agent_loop",
        declaring_node_type: "pattern",
        input_schema: { type: "object" },
        output_schema: {
          type: "object",
          required: [
            "status",
            "attempts_exhausted",
            "attempts",
            "validation",
            "final_validation",
            "gates",
            "result"
          ],
          properties: {
            status: { enum: ["passed", "failed"] },
            attempts_exhausted: { type: "boolean" },
            attempts: { type: "array" },
            validation: { type: "object" },
            final_validation: { type: "object" },
            gates: { type: "array" },
            result: { type: "object" }
          }
        },
        expand: { type: "declaring_node_subgraph" }
      }
    },
    gates: {
      "quality-gates.validation_commands": {
        id: "quality-gates.validation_commands",
        input_schema: { type: "object" },
        decision_schema: { type: "object" },
        output_schema: { type: "object" },
        interrupt: "none"
      },
      "quality-gates.non_empty_diff": {
        id: "quality-gates.non_empty_diff",
        input_schema: { type: "object" },
        decision_schema: { type: "object" },
        output_schema: { type: "object" },
        interrupt: "none"
      },
      "quality-gates.agent_review": {
        id: "quality-gates.agent_review",
        input_schema: { type: "object" },
        decision_schema: { type: "object" },
        output_schema: { type: "object" },
        interrupt: "none"
      }
    }
  })
]);

const agentDefaults: WorkflowAgentDefaults = {
  instructions: "Review the workflow output.",
  model_profile: { model: "openai/gpt-5", reasoning_effort: "medium" },
  tools: { tools: [], runtime_requirements: [] },
  context: { repository: "luna" }
};

function workflow(nodes: WorkflowNode[]): WorkflowDefinition {
  return {
    id: "runner-test",
    type: "workflow",
    mode: "read_only",
    directory: "/tmp/runner-test",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: { type: "object" },
    output_schema_content: { type: "object" },
    capabilities: ["quality-gates"],
    graph: { nodes },
    revision: "revision-1",
    external_definition_digests: {},
    execution: { max_concurrency: 1 },
    requires: { repository: false },
    observability: { exporters: { runtime_log: { enabled: true, required: false } } },
    subagent_policy: { allow_write: false }
  };
}

function backends() {
  return {
    artifacts: createMemoryArtifactManifestStore(),
    events: createMemoryEventStore(),
    interrupts: createMemoryInterruptStore(),
    checkpoints: createMemoryCheckpointStore(),
    runtimeLogs: createMemoryRuntimeLogStore()
  };
}

function sequentialAgentRuntime(
  outputs: Array<unknown | Awaited<ReturnType<AgentRuntimePort["runAgent"]>>>
): AgentRuntimePort {
  const runAgent = vi.fn(async () => {
    const next = outputs.shift();
    if (next === undefined) {
      throw new Error("missing test agent output");
    }

    if (
      typeof next === "object" &&
      next !== null &&
      Object.prototype.hasOwnProperty.call(next, "output")
    ) {
      return next as Awaited<ReturnType<AgentRuntimePort["runAgent"]>>;
    }

    return { output: next };
  });

  return {
    describe: () => ({
      id: "test-agent-runtime",
      display_name: "Test",
      supported_tool_protocols: ["local"],
      supported_runtime_requirements: ["tool_calling", "mcp_tools"]
    }),
    validate: vi.fn(),
    runAgent
  };
}

async function emptyGitWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "luna-runner-git-"));
  await execFileAsync("git", ["init"], { cwd: directory });

  return directory;
}

describe("gated agent loop LangGraph executor", () => {
  it("runs with the LangGraph checkpointer enabled", async () => {
    const checkpointRoot = await mkdtemp(path.join(tmpdir(), "luna-runner-checkpoint-"));
    const checkpointStore = createSqliteCheckpointStore({
      filePath: sqliteCheckpointFile(checkpointRoot)
    });
    const definition = workflow([{ id: "ok", type: "built_in", uses: "runtime.ok" }]);

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-with-langgraph-checkpointer",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: { ...backends(), checkpoints: checkpointStore },
      builtIns: { "runtime.ok": async () => ({ ok: true }) },
      agentRuntime: sequentialAgentRuntime([]),
      langGraphCheckpointer: createLangGraphCheckpointer(checkpointStore)
    });

    expect(result.status).toBe("succeeded");
    await expect(
      checkpointStore.load("run-with-langgraph-checkpointer")
    ).resolves.toMatchObject({
      state: { state_schema_version: "2026-06" }
    });
  });

  it("executes quality-gates.gated_agent_loop pattern nodes through internal agents and gates", async () => {
    const workspacePath = await emptyGitWorkspace();
    const wrongDefaultCwd = await emptyGitWorkspace();
    const summary = createObservabilitySummary({
      runId: "run-gated-loop",
      workflowId: "runner-test"
    });
    const runtime = sequentialAgentRuntime([
      {
        output: { files_changed: ["src/example.ts"] },
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      },
      {
        output: { decision: "pass", feedback: { message: "looks good" } },
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
      },
      {
        output: {
          status: "accepted",
          summary: "accepted with evidence",
          blocking_reasons: [],
          recommended_action: "continue"
        },
        usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 }
      }
    ]);
    const definition = workflow([
      {
        id: "implementation",
        type: "pattern",
        uses: "quality-gates.gated_agent_loop",
        worker: "code-implementer",
        input: { prompt: "implement the change" },
        gates: [
          {
            id: "validation",
            type: "quality-gates.validation_commands",
            input: {
              commands: [{ cmd: "node", args: ["-e", "process.exit(0)"] }],
              max_output_bytes: 1024
            }
          },
          {
            id: "review",
            type: "quality-gates.agent_review",
            input: {
              review_agent: "change-reviewer",
              subject: { expression: "$.gate" }
            },
            block_when: { expression: "$.gate.decision = 'fail'" },
            feedback: { expression: "$.gate.feedback" }
          },
          {
            id: "acceptance",
            type: "quality-gates.agent_review",
            input: {
              review_agent: "change-acceptance-reviewer",
              subject: { expression: "$.gate" }
            },
            block_when: { expression: "$.gate.status != 'accepted'" },
            feedback: { expression: "$.gate.summary" }
          }
        ],
        repair: { attempts: 0 }
      }
    ]);

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-gated-loop",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      runtimeContext: { workspace: { path: workspacePath } },
      backends: backends(),
      builtIns: {},
      agentRuntime: runtime,
      observabilitySummary: summary,
      agentInputs: {
        [gatedAgentWorkerKey("implementation")]: {
          ...agentDefaults,
          cwd: wrongDefaultCwd,
          output_schema: { type: "object", additionalProperties: true }
        },
        [gatedAgentGateKey("implementation", "review")]: {
          ...agentDefaults,
          output_schema: {
            type: "object",
            additionalProperties: false,
            required: ["decision"],
            properties: {
              decision: { enum: ["pass", "fail"] },
              feedback: { type: "object" }
            }
          }
        },
        [gatedAgentGateKey("implementation", "acceptance")]: {
          ...agentDefaults,
          output_schema: {
            type: "object",
            additionalProperties: false,
            required: ["status", "summary", "blocking_reasons", "recommended_action"],
            properties: {
              status: { enum: ["accepted", "rejected", "needs_human_review"] },
              summary: { type: "string" },
              blocking_reasons: { type: "array", items: { type: "string" } },
              recommended_action: { type: "string" }
            }
          }
        }
      }
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected workflow to succeed");
    }
    expect(result.output).toMatchObject({
      status: "passed",
      attempts_exhausted: false,
      result: {
        status: "passed",
        review: { decision: "pass" }
      }
    });
    expect(runtime.runAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        node_id: gatedAgentWorkerKey("implementation"),
        agent_id: "code-implementer"
      })
    );
    expect(runtime.runAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cwd: workspacePath
      })
    );
    expect(runtime.runAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        node_id: gatedAgentGateKey("implementation", "review"),
        agent_id: "change-reviewer",
        cwd: workspacePath,
        input: expect.objectContaining({
          subject: expect.objectContaining({
            output: { files_changed: ["src/example.ts"] },
            outputs: {}
          })
        })
      })
    );
    expect(runtime.runAgent).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        node_id: gatedAgentGateKey("implementation", "acceptance"),
        agent_id: "change-acceptance-reviewer",
        input: expect.objectContaining({
          subject: expect.objectContaining({
            output: { files_changed: ["src/example.ts"] },
            outputs: {
              review: { decision: "pass", feedback: { message: "looks good" } }
            }
          })
        })
      })
    );
    expect(summary).toMatchObject({
      prompt_operations: 3,
      usage_missing_count: 0,
      tokens: {
        input: 17,
        output: 13,
        total: 30
      }
    });
  });

  it("blocks the loop when a non-empty diff gate sees no repository changes", async () => {
    const workspacePath = await emptyGitWorkspace();
    const runtime = sequentialAgentRuntime([
      { status: "implemented", changed_files: ["src/example.ts"] },
      { decision: "pass" }
    ]);
    const definition = workflow([
      {
        id: "implementation",
        type: "pattern",
        uses: "quality-gates.gated_agent_loop",
        worker: "code-implementer",
        input: { prompt: "implement the change" },
        gates: [
          {
            id: "diff",
            type: "quality-gates.non_empty_diff",
            input: {}
          },
          {
            id: "review",
            type: "quality-gates.agent_review",
            input: {
              review_agent: "change-reviewer",
              subject: { expression: "$.gate.output" }
            },
            block_when: { expression: "$.gate.decision = 'fail'" }
          }
        ],
        repair: { attempts: 0 }
      }
    ]);

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-empty-diff-gate",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      runtimeContext: { workspace: { path: workspacePath } },
      backends: backends(),
      builtIns: {},
      agentRuntime: runtime,
      agentInputs: {
        [gatedAgentWorkerKey("implementation")]: {
          ...agentDefaults,
          output_schema: { type: "object", additionalProperties: true }
        },
        [gatedAgentGateKey("implementation", "review")]: {
          ...agentDefaults,
          output_schema: {
            type: "object",
            additionalProperties: false,
            required: ["decision"],
            properties: { decision: { enum: ["pass", "fail"] } }
          }
        }
      }
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected workflow to succeed");
    }
    expect(result.output).toMatchObject({
      status: "failed",
      attempts_exhausted: true,
      gates: [
        {
          id: "diff",
          type: "quality-gates.non_empty_diff",
          passed: false,
          feedback: expect.stringContaining("No repository changes")
        }
      ]
    });
    expect(runtime.runAgent).toHaveBeenCalledTimes(1);
  });
});
