import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
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
  gatedAgentGateKey,
  gatedAgentWorkerKey
} from "../../../src/capabilities/quality-gates/gated-agent-loop-keys.js";
import { collectWorktreeDiff } from "../../../src/capabilities/git/diff/worktree-diff.js";
import { createQualityGatePatternExecutors } from "../../../src/capabilities/quality-gates/workflow-pattern-executor.js";
import { runValidationCommands } from "../../../src/capabilities/validation/command-runner.js";
import {
  runCompiledWorkflow,
  type WorkflowAgentDefaults
} from "../../../src/runtime/langgraph/workflow-runner.js";

const execFileAsync = promisify(execFile);
const qualityGatePatternExecutors = createQualityGatePatternExecutors({
  runValidationCommands,
  collectDiffSummary: collectWorktreeDiff
});

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "quality-gates",
    kind: "execution",
    version: "1.0.0",
    patterns: {
      "quality-gates.gated_agent_loop": {
        id: "quality-gates.gated_agent_loop",
        declaring_node_type: "pattern",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
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

function agentDefaults(agentId: string): WorkflowAgentDefaults {
  return {
    agent: {
      id: agentId,
      mode: "trusted_local_write",
      instructions: "Review the workflow output."
    },
    model_profile: { model: "openai/gpt-5", reasoning_effort: "medium" },
    tools: { tools: [], runtime_requirements: [] }
  };
}

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
  it("executes quality-gates.gated_agent_loop pattern nodes through internal agents and gates", async () => {
    const workspacePath = await emptyGitWorkspace();
    const wrongDefaultCwd = await emptyGitWorkspace();
    const runtime = sequentialAgentRuntime([
      {
        output: { files_changed: ["src/example.ts"] }
      },
      {
        output: { decision: "pass", feedback: { message: "looks good" } }
      },
      {
        output: {
          status: "accepted",
          summary: "accepted with evidence",
          blocking_reasons: [],
          recommended_action: "continue"
        }
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
    const runtimeBackends = backends();

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
      backends: runtimeBackends,
      builtIns: {},
      patternExecutors: qualityGatePatternExecutors,
      agentRuntime: runtime,
      agentInputs: {
        [gatedAgentWorkerKey("implementation")]: {
          ...agentDefaults("code-implementer"),
          cwd: wrongDefaultCwd,
          output_schema: { type: "object", additionalProperties: true }
        },
        [gatedAgentGateKey("implementation", "review")]: {
          ...agentDefaults("change-reviewer"),
          output_schema: { type: "object", additionalProperties: true }
        },
        [gatedAgentGateKey("implementation", "acceptance")]: {
          ...agentDefaults("change-acceptance-reviewer"),
          output_schema: { type: "object", additionalProperties: true }
        }
      }
    });

    expect(result.status).toBe("succeeded");
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
  });

});
