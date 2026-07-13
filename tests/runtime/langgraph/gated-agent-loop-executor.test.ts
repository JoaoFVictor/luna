import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
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
import { createSqliteCheckpointStore } from "../../../src/runtime/backends/sqlite/checkpoints.js";
import { RuntimeDurabilityRecoveryRequiredError } from "../../../src/core/runtime/errors.js";
import type { CheckpointStore } from "../../../src/core/runtime/backends/contracts.js";
import { patternStageOccurrenceNodeId } from "../../../src/core/workflow/loop-identity.js";
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
const runValidationCommandsSpy = vi.fn(runValidationCommands);
const qualityGatePatternExecutors = createQualityGatePatternExecutors({
  runValidationCommands: runValidationCommandsSpy,
  collectDiffSummary: collectWorktreeDiff
});

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "quality-gates",
    kind: "execution",
    version: "1.0.0",
    built_ins: {
      "quality-gates.test_context": {
        id: "quality-gates.test_context",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        required_ports: []
      }
    },
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

const reviewerContext = {
  kind: "luna.collect_context.v1",
  repository: {
    root: "/repo",
    configured: [],
    read: [],
    missing: [],
    skipped: []
  },
  agents: [{
    id: "change-reviewer",
    root: "/agents/change-reviewer",
    configured: ["review-context.md"],
    read: [{
      path: "review-context.md",
      bytes: 29,
      content: "Reviewer contextual guidance.\n"
    }],
    missing: [],
    skipped: []
  }]
} as const;

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
  await execFileAsync("git", [
    "-c", "user.name=Luna Test",
    "-c", "user.email=luna@example.invalid",
    "commit", "--allow-empty", "-m", "Initial"
  ], { cwd: directory });

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
        id: "context",
        type: "built_in",
        uses: "quality-gates.test_context"
      },
      {
        id: "implementation",
        type: "pattern",
        uses: "quality-gates.gated_agent_loop",
        worker: "code-implementer",
        input: {
          prompt: "implement the change",
          context: { expression: "$.steps.context" }
        },
        evidence: [
          {
            id: "repository_context",
            uses: "quality-gates.test_context",
            input: {
              attempt: { expression: "$.gate.attempt" },
              diff_summary: { expression: "$.gate.diff_summary" }
            }
          }
        ],
        gates: [
          {
            id: "validation",
            type: "quality-gates.validation_commands",
            input: {
              commands: {
                expression: "$.repository.validation.commands"
              },
              env_allowlist: {
                expression: "$.repository.validation.env_allowlist"
              },
              max_output_bytes: {
                expression: "$.config.implementation.validation.max_output_bytes"
              }
            }
          },
          {
            id: "review",
            type: "quality-gates.agent_review",
            input: {
              review_agent: "change-reviewer",
              context: { expression: "$.steps.context" },
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
              context: { expression: "$.steps.context" },
              subject: { expression: "$.gate" }
            },
            block_when: { expression: "$.gate.status != 'accepted'" },
            feedback: { expression: "$.gate.summary" }
          }
        ],
        repair: { attempts: 0 },
        after: ["context"]
      }
    ]);
    const runtimeBackends = backends();
    const testContextBuiltIn = vi.fn(async ({ node, input }: {
      node: { readonly id: string };
      input: unknown;
    }) => node.id.includes(":evidence:")
      ? { resolved_input: input }
      : reviewerContext);

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {
        implementation: {
          validation: {
            max_output_bytes: 4096
          }
        }
      },
      run: {
        run_id: "run-gated-loop",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      runtimeContext: {
        workspace: { path: workspacePath },
        repository: {
          validation: {
            commands: [{ cmd: "git", args: ["status", "--short"] }],
            env_allowlist: ["ALLOWED_TOKEN"]
          }
        }
      },
      backends: runtimeBackends,
      builtIns: {
        "quality-gates.test_context": testContextBuiltIn
      },
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
        context: reviewerContext,
        instructions: expect.stringContaining("Reviewer contextual guidance."),
        input: expect.objectContaining({
          context_audit: expect.objectContaining({
            agent: expect.objectContaining({ id: "change-reviewer" })
          }),
          subject: expect.objectContaining({
            output: { files_changed: ["src/example.ts"] },
            evidence: {
              repository_context: {
                resolved_input: {
                  attempt: 1,
                  diff_summary: expect.any(Object)
                }
              }
            },
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
    expect(runValidationCommandsSpy).toHaveBeenCalledWith({
      cwd: workspacePath,
      commands: [{ cmd: "git", args: ["status", "--short"] }],
      envAllowlist: ["ALLOWED_TOKEN"],
      maxOutputBytes: 4096
    });
    expect(result.state.steps.implementation).toMatchObject({
      attempts: [{
        validated_snapshot: expect.objectContaining({ kind: "git_worktree_tree.v1" }),
        evidence: { repository_context: expect.any(Object) }
      }],
      result: {
        validated_snapshot: expect.objectContaining({ kind: "git_worktree_tree.v1" }),
        evidence: { repository_context: expect.any(Object) }
      }
    });
  });

  it("rejects a worktree mutation between durable validation and diff collection", async () => {
    const workspacePath = await emptyGitWorkspace();
    const changedPath = path.join(workspacePath, "change.txt");
    await writeFile(changedPath, "validated\n", "utf8");
    const runtime = sequentialAgentRuntime([{ output: { summary: "implemented" } }]);
    const definition = workflow([{
      id: "implementation",
      type: "pattern",
      uses: "quality-gates.gated_agent_loop",
      worker: "code-implementer",
      input: { prompt: "implement the change" },
      repair: { attempts: 0 }
    }]);
    const mutatingPatternExecutors = createQualityGatePatternExecutors({
      runValidationCommands: runValidationCommandsSpy,
      collectDiffSummary: async (input) => {
        await writeFile(changedPath, "mutated after validation\n", "utf8");
        return await collectWorktreeDiff(input);
      }
    });

    await expect(runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-validation-diff-mutation",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      runtimeContext: { workspace: { path: workspacePath } },
      backends: backends(),
      builtIns: {},
      patternExecutors: mutatingPatternExecutors,
      agentRuntime: runtime,
      agentInputs: {
        [gatedAgentWorkerKey("implementation")]: {
          ...agentDefaults("code-implementer"),
          cwd: workspacePath,
          output_schema: { type: "object", additionalProperties: true }
        }
      }
    })).rejects.toMatchObject({
      code: "runtime_state_invalid",
      message: "Worktree changed between validation and diff collection"
    });
  });

  it("rejects validation commands that mutate the worktree", async () => {
    const workspacePath = await emptyGitWorkspace();
    const runtime = sequentialAgentRuntime([{ output: { summary: "implemented" } }]);
    const definition = workflow([{
      id: "implementation",
      type: "pattern",
      uses: "quality-gates.gated_agent_loop",
      worker: "code-implementer",
      input: { prompt: "implement the change" },
      gates: [{
        id: "validation",
        type: "quality-gates.validation_commands",
        input: {
          commands: [{
            cmd: "sh",
            args: ["-c", "printf mutation > validation-side-effect.txt"]
          }],
          env_allowlist: [],
          max_output_bytes: 4096
        }
      }],
      repair: { attempts: 0 }
    }]);
    const collectDiffSummary = vi.fn(collectWorktreeDiff);

    await expect(runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-validation-side-effect",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      runtimeContext: { workspace: { path: workspacePath } },
      backends: backends(),
      builtIns: {},
      patternExecutors: createQualityGatePatternExecutors({
        runValidationCommands: runValidationCommandsSpy,
        collectDiffSummary
      }),
      agentRuntime: runtime,
      agentInputs: {
        [gatedAgentWorkerKey("implementation")]: {
          ...agentDefaults("code-implementer"),
          cwd: workspacePath,
          output_schema: { type: "object", additionalProperties: true }
        }
      }
    })).rejects.toMatchObject({
      code: "runtime_state_invalid",
      message: "Validation commands changed the worktree; validation must be read-only"
    });
    expect(collectDiffSummary).not.toHaveBeenCalled();
  });

  it.each([
    ["after worker output", "worker"],
    ["after evidence output", "evidence:repository_context"],
    ["between reviewers", "reviewer:review"]
  ] as const)("recovers %s without replaying output-pending pattern stages", async (
    _label,
    crashAfterOutputStage
  ) => {
    const result = await crashAndRecoverPattern({ crashAfterOutputStage });

    expect(result.workerCalls).toBe(1);
    expect(result.evidenceCalls).toBe(1);
    expect(result.agentIds).toEqual([
      "code-implementer",
      "change-reviewer",
      "change-acceptance-reviewer"
    ]);
    expect(result.output.status).toBe("succeeded");
  });

  it("crosses the authoritative pre-execution barrier before the worker", async () => {
    const result = await crashAndRecoverPattern({
      crashBeforeStage: "worker"
    });

    // The explicitly authorized second invocation is the only model call.
    // The first invocation stopped at the durable barrier before the worker.
    expect(result.workerCalls).toBe(1);
    expect(result.agentIds[0]).toBe("code-implementer");
    expect(result.output.status).toBe("succeeded");
  });

  it("recovers completed stages after reopening the SQLite checkpoint store", async () => {
    const checkpointRoot = await mkdtemp(path.join(tmpdir(), "luna-pattern-sqlite-"));
    const result = await crashAndRecoverPattern({
      crashAfterOutputStage: "reviewer:review",
      checkpointFile: path.join(checkpointRoot, "checkpoints.sqlite")
    });

    expect(result.workerCalls).toBe(1);
    expect(result.evidenceCalls).toBe(1);
    expect(result.agentIds).toEqual([
      "code-implementer",
      "change-reviewer",
      "change-acceptance-reviewer"
    ]);
    expect(result.output.status).toBe("succeeded");
  });

  it.each([
    { failedGate: "validation", commands: [{ cmd: "quality-check" }] },
    { failedGate: "diff", commands: [] }
  ])("does not collect evidence when the $failedGate gate fails", async ({
    failedGate,
    commands
  }) => {
    const workspacePath = await emptyGitWorkspace();
    const runtime = sequentialAgentRuntime([{
      output: { files_changed: [] }
    }]);
    const evidenceBuiltIn = vi.fn(async () => ({ repository: "context" }));
    const definition = workflow([{
      id: "implementation",
      type: "pattern",
      uses: "quality-gates.gated_agent_loop",
      worker: "code-implementer",
      evidence: [{
        id: "repository_context",
        uses: "quality-gates.test_context"
      }],
      gates: [
        {
          id: "validation",
          type: "quality-gates.validation_commands",
          input: {
            commands,
            env_allowlist: [],
            max_output_bytes: 4096
          }
        },
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
            subject: { expression: "$.gate" }
          },
          block_when: { expression: "$.gate.decision = 'fail'" }
        }
      ],
      repair: { attempts: 0 }
    }]);
    if (failedGate === "validation") {
      runValidationCommandsSpy.mockResolvedValueOnce({
        passed: false,
        commands: [{
          cmd: "quality-check",
          exit_code: 1,
          stdout: "",
          stderr: "quality check failed",
          stdout_truncated: false,
          stderr_truncated: false,
          duration_ms: 1,
          timed_out: false
        }]
      });
    }

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: `run-gated-loop-${failedGate}`,
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      runtimeContext: {
        workspace: { path: workspacePath }
      },
      backends: backends(),
      builtIns: {
        "quality-gates.test_context": evidenceBuiltIn
      },
      patternExecutors: qualityGatePatternExecutors,
      agentRuntime: runtime,
      agentInputs: {
        [gatedAgentWorkerKey("implementation")]: {
          ...agentDefaults("code-implementer"),
          cwd: workspacePath,
          output_schema: { type: "object", additionalProperties: true }
        },
        [gatedAgentGateKey("implementation", "review")]: {
          ...agentDefaults("change-reviewer"),
          output_schema: { type: "object", additionalProperties: true }
        }
      }
    });

    expect(evidenceBuiltIn).not.toHaveBeenCalled();
    expect(runtime.runAgent).toHaveBeenCalledTimes(1);
    expect(result.state.steps.implementation).toMatchObject({
      status: "failed",
      result: { status: "failed" }
    });
    expect(result.state.steps.implementation).toHaveProperty(
      "attempts.0.gate_results",
      expect.arrayContaining([
        expect.objectContaining({ id: failedGate, passed: false })
      ])
    );
    expect(result.state.steps.implementation).not.toHaveProperty("result.evidence");
  });

});

async function crashAndRecoverPattern({
  crashBeforeStage,
  crashAfterOutputStage,
  checkpointFile
}: {
  readonly crashBeforeStage?: string;
  readonly crashAfterOutputStage?: string;
  readonly checkpointFile?: string;
}) {
  if ((crashBeforeStage === undefined) === (crashAfterOutputStage === undefined)) {
    throw new Error("Select exactly one pattern crash boundary");
  }
  const workspacePath = await emptyGitWorkspace();
  const definition = workflow([{
    id: "implementation",
    type: "pattern",
    uses: "quality-gates.gated_agent_loop",
    worker: "code-implementer",
    evidence: [{
      id: "repository_context",
      uses: "quality-gates.test_context",
      input: { attempt: { expression: "$.gate.attempt" } }
    }],
    gates: [{
      id: "review",
      type: "quality-gates.agent_review",
      input: {
        review_agent: "change-reviewer",
        subject: { expression: "$.gate" }
      },
      block_when: { expression: "$.gate.decision = 'fail'" }
    }, {
      id: "acceptance",
      type: "quality-gates.agent_review",
      input: {
        review_agent: "change-acceptance-reviewer",
        subject: { expression: "$.gate" }
      },
      block_when: { expression: "$.gate.status != 'accepted'" }
    }],
    repair: { attempts: 0 }
  }]);
  const compiled = compileWorkflow({ workflow: definition, registry });
  const runtime = sequentialAgentRuntime([{
    output: { files_changed: ["src/example.ts"] }
  }, {
    output: { decision: "pass" }
  }, {
    output: { status: "accepted", summary: "ok" }
  }]);
  let evidenceCalls = 0;
  const builtIns = {
    "quality-gates.test_context": async () => {
      evidenceCalls += 1;
      return { repository: "context" };
    }
  };
  const durableCheckpointStore = checkpointFile === undefined
    ? createMemoryCheckpointStore()
    : createSqliteCheckpointStore({ filePath: checkpointFile });
  const crashStage = crashBeforeStage ?? crashAfterOutputStage!;
  const targetNodeId = patternStageOccurrenceNodeId({
    pattern_node_id: "implementation",
    attempt: 1,
    stage_id: crashStage
  });
  let crashed = false;
  const checkpointStore: CheckpointStore = crashAfterOutputStage === undefined
    ? durableCheckpointStore
    : {
        ...durableCheckpointStore,
        async saveWrites(writes) {
          const isTargetCompletion = writes.some(
            (write) => write.task_id === targetNodeId &&
              write.channel === "node_completion"
          );
          if (!crashed && isTargetCompletion) {
            crashed = true;
            throw new RuntimeDurabilityRecoveryRequiredError(
              "simulated process loss after durable pattern output"
            );
          }
          await durableCheckpointStore.saveWrites(writes);
        }
      };
  const firstBackends = { ...backends(), checkpoints: checkpointStore };
  const run = {
    run_id: `run-pattern-recovery-${crashStage.replace(/[^a-z]+/gu, "-")}`,
    workflow_id: definition.id,
    attempt: 1,
    started_at: "2026-07-13T00:00:00.000Z"
  } as const;
  const agentInputs = {
    [gatedAgentWorkerKey("implementation")]: {
      ...agentDefaults("code-implementer"),
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
  };
  const common = {
    compiled,
    workflow: definition,
    invocation: {},
    config: {},
    run,
    runtimeContext: { workspace: { path: workspacePath } },
    builtIns,
    patternExecutors: qualityGatePatternExecutors,
    agentRuntime: runtime,
    agentInputs
  } as const;

  await expect(runCompiledWorkflow({
    ...common,
    backends: firstBackends,
    onBeforeNodeExecution: async ({ node_id }) => {
      if (
        crashBeforeStage !== undefined &&
        !crashed &&
        node_id === targetNodeId
      ) {
        crashed = true;
        throw new RuntimeDurabilityRecoveryRequiredError(
          "simulated process loss between durable pattern stages"
        );
      }
    }
  })).rejects.toBeInstanceOf(RuntimeDurabilityRecoveryRequiredError);

  const secondBackends = checkpointFile === undefined
    ? firstBackends
    : { ...backends(), checkpoints: createSqliteCheckpointStore({ filePath: checkpointFile }) };
  const output = await runCompiledWorkflow({
    ...common,
    backends: secondBackends
  });
  const agentIds = (runtime.runAgent as ReturnType<typeof vi.fn>).mock.calls.map(
    ([input]) => (input as { agent_id: string }).agent_id
  );
  return {
    output,
    agentIds,
    evidenceCalls,
    workerCalls: agentIds.filter((id) => id === "code-implementer").length
  };
}
