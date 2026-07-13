import { describe, expect, it, vi } from "vitest";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import { runCompiledWorkflow, resumeCompiledWorkflow } from "../../../src/runtime/langgraph/workflow-runner.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "test",
    kind: "execution",
    version: "1",
    built_ins: {
      "test.revise": {
        id: "test.revise",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        required_ports: []
      },
      "test.publish": {
        id: "test.publish",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        required_ports: []
      }
    },
    gates: {
      "test.review": {
        id: "test.review",
        input_schema: { type: "object" },
        decision_schema: { type: "object" },
        output_schema: { type: "object" },
        interrupt: "required"
      }
    },
    artifact_publishers: {
      "test.publisher": {
        id: "test.publisher",
        source_node_ownership: "declaring_node",
        path_policy: "declared_path",
        overwrite_policy: "forbid",
        manifest_transaction: "required"
      }
    }
  })
]);

const workflow: WorkflowDefinition = {
  id: "durable-loop-test",
  type: "workflow",
  mode: "read_only",
  directory: "/tmp/durable-loop-test",
  input_schema: "input.json",
  output_schema: "output.json",
  input_schema_content: { type: "object" },
  output_schema_content: { type: "object" },
  capabilities: ["test"],
  graph: {
    nodes: [{
      id: "editorial",
      type: "loop",
      body: {
        nodes: [
          {
            id: "draft",
            type: "built_in",
            uses: "test.revise",
            input: {
              previous: {
                expression: "$exists($.steps.draft.count) ? $.steps.draft.count : 0"
              }
            },
            artifacts: [{
              path: "draft.json",
              source: { expression: "$.steps.draft" },
              format: "json",
              required: true,
              publisher: "test.publisher"
            }]
          },
          {
            id: "review",
            type: "human_gate",
            uses: "test.review",
            input: {
              prompt: "Review",
              review: {
                targets: [
                  { id: "text", label: "Text" },
                  { id: "image", label: "Image" }
                ]
              }
            },
            after: ["draft"]
          }
        ]
      },
      repeat_when: { expression: "$.steps.review.action = 'request_changes'" },
      result: {
        expression: "{'action': $.steps.review.action, 'count': $.steps.draft.count}"
      },
      halt_when: { expression: "$.result.action = 'reject'" }
    }, {
      id: "publish",
      type: "built_in",
      uses: "test.publish",
      input: { post: { expression: "$.steps.editorial" } },
      after: ["editorial"]
    }]
  },
  revision: "loop-revision-1",
  external_definition_digests: {},
  execution: { max_concurrency: 1 },
  requires: { repository: false },
  observability: { exporters: { runtime_log: { enabled: false, required: false } } },
  subagent_policy: { allow_write: false }
};

const agentRuntime: AgentRuntimePort = {
  describe: () => ({
    id: "none",
    display_name: "No agent runtime",
    supported_runtime_requirements: [],
    supported_tool_protocols: []
  }),
  validate: () => undefined,
  runAgent: async () => { throw new Error("unused"); }
};

function stores() {
  return {
    artifacts: createMemoryArtifactManifestStore(),
    events: createMemoryEventStore(),
    interrupts: createMemoryInterruptStore(),
    checkpoints: createMemoryCheckpointStore(),
    runtimeLogs: createMemoryRuntimeLogStore()
  };
}

describe("durable workflow loop", () => {
  it("propagates the pre-node durability barrier before a loop body executor", async () => {
    const execute = vi.fn(() => ({ count: 1 }));
    const barrier = vi.fn(async () => {
      throw new Error("resume stage fsync failed");
    });

    await expect(runCompiledWorkflow({
      compiled: compileWorkflow({ workflow, registry }),
      workflow,
      invocation: {},
      config: {},
      run: {
        run_id: "run-durable-loop-barrier",
        workflow_id: workflow.id,
        attempt: 1,
        started_at: "2026-07-12T00:00:00.000Z"
      },
      backends: stores(),
      builtIns: {
        "test.revise": execute,
        "test.publish": () => ({ published: true })
      },
      onBeforeNodeExecution: barrier,
      agentRuntime
    })).rejects.toThrow("resume stage fsync failed");

    expect(barrier).toHaveBeenCalledWith({
      node_id: "editorial:iteration-1:draft",
      attempt: 1
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("resumes more than ten human-requested revisions without a configured limit", async () => {
    const backends = stores();
    const compiled = compileWorkflow({ workflow, registry });
    const publishedPaths = new Set<string>();
    const publishedNodeIds = new Set<string>();
    const executedNodeIds = new Set<string>();
    let executions = 0;
    let publishes = 0;
    const common = {
      compiled,
      workflow,
      backends,
      builtIns: {
        "test.revise": ({ input, node }: { input: unknown; node: { id: string } }) => {
          executions += 1;
          if (executedNodeIds.has(node.id)) throw new Error(`replayed node: ${node.id}`);
          executedNodeIds.add(node.id);
          return {
            count: Number((input as { previous: number }).previous) + 1
          };
        },
        "test.publish": () => {
          publishes += 1;
          return { published: true };
        }
      },
      artifactPublisher: {
        async publish({ node_id, path }: { node_id: string; path: string }) {
          if (publishedPaths.has(path)) throw new Error(`duplicate path: ${path}`);
          if (publishedNodeIds.has(node_id)) throw new Error(`duplicate node id: ${node_id}`);
          publishedPaths.add(path);
          publishedNodeIds.add(node_id);
          return { id: path, uri: `memory://${path}`, node_id };
        }
      },
      agentRuntime
    };
    let result = await runCompiledWorkflow({
      ...common,
      invocation: {},
      config: {},
      run: {
        run_id: "run-durable-loop",
        workflow_id: workflow.id,
        attempt: 1,
        started_at: "2026-07-12T00:00:00.000Z"
      }
    });
    expect(result.state.steps.draft).toBeUndefined();
    expect(result.state.steps.review).toBeUndefined();

    const interruptIds = new Set<string>();
    for (let index = 0; index < 12; index += 1) {
      expect(result.status).toBe("waiting_for_input");
      if (result.status !== "waiting_for_input") throw new Error("expected wait");
      interruptIds.add(result.interrupt_id);
      result = await resumeCompiledWorkflow({
        ...common,
        thread_id: "run-durable-loop",
        checkpoint_id: result.checkpoint_id,
        interrupt_id: result.interrupt_id,
        decision: { action: "request_changes" }
      });
      expect(result.state.steps.draft).toBeUndefined();
      expect(result.state.steps.review).toBeUndefined();
    }

    expect(result.status).toBe("waiting_for_input");
    if (result.status !== "waiting_for_input") throw new Error("expected final wait");
    interruptIds.add(result.interrupt_id);
    result = await resumeCompiledWorkflow({
      ...common,
      thread_id: "run-durable-loop",
      checkpoint_id: result.checkpoint_id,
      interrupt_id: result.interrupt_id,
      decision: { action: "approve" }
    });

    expect(interruptIds).toHaveLength(13);
    expect(executions).toBe(13);
    expect(publishedPaths).toHaveLength(13);
    expect(publishedNodeIds).toHaveLength(13);
    expect(executedNodeIds).toHaveLength(13);
    expect([...executedNodeIds]).toContain("editorial:iteration-13:draft");
    expect([...publishedPaths]).toContain("loops/editorial/iterations/13/draft.json");
    expect(publishes).toBe(1);
    expect(result.status).toBe("succeeded");
    expect(result.state.steps.editorial).toEqual({ action: "approve", count: 13 });
    expect(result.state.steps.draft).toBeUndefined();
    expect(result.state.steps.review).toBeUndefined();
  });

  it("completes a rejected loop successfully without scheduling downstream nodes", async () => {
    const backends = stores();
    const compiled = compileWorkflow({ workflow, registry });
    let publishes = 0;
    const common = {
      compiled,
      workflow,
      backends,
      builtIns: {
        "test.revise": ({ input }: { input: unknown }) => ({
          count: Number((input as { previous: number }).previous) + 1
        }),
        "test.publish": () => {
          publishes += 1;
          return { published: true };
        }
      },
      artifactPublisher: {
        async publish({ node_id, path }: { node_id: string; path: string }) {
          return { id: path, uri: `memory://${path}`, node_id };
        }
      },
      agentRuntime
    };
    let result = await runCompiledWorkflow({
      ...common,
      invocation: {},
      config: {},
      run: {
        run_id: "run-durable-loop-reject",
        workflow_id: workflow.id,
        attempt: 1,
        started_at: "2026-07-12T00:00:00.000Z"
      }
    });
    if (result.status !== "waiting_for_input") throw new Error("expected wait");
    result = await resumeCompiledWorkflow({
      ...common,
      thread_id: "run-durable-loop-reject",
      checkpoint_id: result.checkpoint_id,
      interrupt_id: result.interrupt_id,
      decision: { action: "request_changes" }
    });
    if (result.status !== "waiting_for_input") throw new Error("expected second wait");
    result = await resumeCompiledWorkflow({
      ...common,
      thread_id: "run-durable-loop-reject",
      checkpoint_id: result.checkpoint_id,
      interrupt_id: result.interrupt_id,
      decision: { action: "reject" }
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error("expected success");
    expect(result.output).toEqual({ action: "reject", count: 2 });
    expect(result.state.steps.publish).toBeUndefined();
    expect(publishes).toBe(0);
  });

  it("carries exact artifacts for a body node skipped by a targeted revision", async () => {
    const selectiveWorkflow: WorkflowDefinition = {
      ...workflow,
      id: "durable-loop-selective",
      revision: "loop-selective-revision-1",
      graph: {
        nodes: workflow.graph.nodes.map((node) =>
          node.type !== "loop"
            ? node
            : {
                ...node,
                body: {
                  nodes: node.body.nodes.map((bodyNode) =>
                    bodyNode.id === "draft"
                      ? {
                          ...bodyNode,
                          when: {
                            expression: "$exists($.steps.review.action) ? ('text' in $.steps.review.targets) : true"
                          }
                        }
                      : bodyNode
                  )
                }
              }
        )
      }
    };
    const backends = stores();
    const compiled = compileWorkflow({ workflow: selectiveWorkflow, registry });
    let executions = 0;
    const common = {
      compiled,
      workflow: selectiveWorkflow,
      backends,
      builtIns: {
        "test.revise": () => ({ count: ++executions }),
        "test.publish": () => ({ published: true })
      },
      artifactPublisher: {
        async publish({ node_id, path }: { node_id: string; path: string }) {
          return { id: path, uri: `memory://${path}`, node_id };
        }
      },
      agentRuntime
    };
    let result = await runCompiledWorkflow({
      ...common,
      invocation: {},
      config: {},
      run: {
        run_id: "run-durable-loop-selective",
        workflow_id: selectiveWorkflow.id,
        attempt: 1,
        started_at: "2026-07-12T00:00:00.000Z"
      }
    });
    if (result.status !== "waiting_for_input") throw new Error("expected wait");
    result = await resumeCompiledWorkflow({
      ...common,
      thread_id: "run-durable-loop-selective",
      checkpoint_id: result.checkpoint_id,
      interrupt_id: result.interrupt_id,
      decision: {
        action: "request_changes",
        comment: "Only regenerate the image",
        targets: ["image"]
      }
    });

    expect(executions).toBe(1);
    expect(result.status).toBe("waiting_for_input");
    const interrupts = await backends.interrupts.list("run-durable-loop-selective");
    expect(interrupts).toHaveLength(2);
    expect(interrupts[1]?.payload?.review?.artifact_refs).toEqual([
      {
        id: "loops/editorial/iterations/1/draft.json",
        uri: "memory://loops/editorial/iterations/1/draft.json",
        node_id: "editorial:iteration-1:draft"
      }
    ]);
    if (result.status !== "waiting_for_input") throw new Error("expected third wait");
    result = await resumeCompiledWorkflow({
      ...common,
      thread_id: "run-durable-loop-selective",
      checkpoint_id: result.checkpoint_id,
      interrupt_id: result.interrupt_id,
      decision: {
        action: "request_changes",
        comment: "Keep changing only the image",
        targets: ["image"]
      }
    });
    expect(executions).toBe(1);
    expect(result.status).toBe("waiting_for_input");
    const afterSecondSkip = await backends.interrupts.list("run-durable-loop-selective");
    expect(afterSecondSkip).toHaveLength(3);
    expect(afterSecondSkip[2]?.payload?.review?.artifact_refs).toEqual([
      {
        id: "loops/editorial/iterations/1/draft.json",
        uri: "memory://loops/editorial/iterations/1/draft.json",
        node_id: "editorial:iteration-1:draft"
      }
    ]);
    expect(result.state.steps.draft).toBeUndefined();
  });

  it("recovers artifact publication without repeating a durable body execution", async () => {
    const backends = stores();
    const compiled = compileWorkflow({ workflow, registry });
    let executions = 0;
    let artifactAttempts = 0;
    const input = {
      compiled,
      workflow,
      invocation: {},
      config: {},
      run: {
        run_id: "run-durable-loop-artifact-recovery",
        workflow_id: workflow.id,
        attempt: 1,
        started_at: "2026-07-12T00:00:00.000Z"
      },
      backends,
      builtIns: {
        "test.revise": () => {
          executions += 1;
          return { count: executions };
        },
        "test.publish": () => ({ published: true })
      },
      artifactPublisher: {
        async publish({ node_id, path }: { node_id: string; path: string }) {
          artifactAttempts += 1;
          if (artifactAttempts === 1) {
            throw new Error("artifact publisher failed after model execution");
          }
          return { id: path, uri: `memory://${path}`, node_id };
        }
      },
      agentRuntime
    };

    await expect(runCompiledWorkflow(input)).rejects.toMatchObject({
      code: "runtime_durability_recovery_required"
    });
    expect(executions).toBe(1);
    expect(artifactAttempts).toBe(1);

    const recovered = await runCompiledWorkflow(input);
    expect(recovered.status).toBe("waiting_for_input");
    expect(executions).toBe(1);
    expect(artifactAttempts).toBe(2);
  });

  it("rejects a schema-shaped binary ref that the artifact authority cannot verify", async () => {
    const backends = stores();
    const compiled = compileWorkflow({ workflow, registry });
    let verificationAttempts = 0;
    await expect(runCompiledWorkflow({
      compiled,
      workflow,
      invocation: {},
      config: {},
      run: {
        run_id: "run-durable-loop-forged-asset",
        workflow_id: workflow.id,
        attempt: 1,
        started_at: "2026-07-12T00:00:00.000Z"
      },
      backends,
      builtIns: {
        "test.revise": ({ node }) => ({
          count: 1,
          asset: {
            id: "forged.png",
            uri: "artifact://run-durable-loop-forged-asset/forged.png",
            node_id: node.id,
            media_type: "image/png",
            content_hash: `sha256:${"a".repeat(64)}`,
            size_bytes: 1
          }
        }),
        "test.publish": () => ({ published: true })
      },
      artifactPublisher: {
        async publish({ node_id, path }) {
          return { id: path, uri: `memory://${path}`, node_id };
        },
        async verify() {
          verificationAttempts += 1;
          return false;
        }
      },
      agentRuntime
    })).rejects.toMatchObject({ code: "runtime_state_invalid" });
    expect(verificationAttempts).toBe(1);
  });
});
