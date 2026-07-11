import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import type {
  CheckpointStore,
  RuntimeBackends
} from "../../../src/core/runtime/backends/contracts.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import type { WorkflowArtifactPublisherPort } from "../../../src/core/workflow/execution-contracts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { LunaLangGraphCheckpointer } from "../../../src/runtime/backends/sqlite/langgraph-checkpointer.js";
import {
  createSqliteCheckpointStore,
  sqliteCheckpointFile
} from "../../../src/runtime/backends/sqlite/checkpoints.js";
import {
  resumeCompiledWorkflow,
  runCompiledWorkflow
} from "../../../src/runtime/langgraph/workflow-runner.js";
import {
  langGraphInterruptBackends,
  langGraphPreArtifact,
  langGraphInterruptRegistry,
  langGraphInterruptWorkflow
} from "./langgraph-interrupt-test-support.js";

const WAIT_COMPLETION_CHANNEL = "interrupt_wait_completion";

class FaultAfterWaitCheckpointer extends LunaLangGraphCheckpointer {
  readonly #waitIsDurable: () => boolean;
  #injected = false;

  constructor(store: CheckpointStore, waitIsDurable: () => boolean) {
    super(store);
    this.#waitIsDurable = waitIsDurable;
  }

  get injected(): boolean {
    return this.#injected;
  }

  override async putWrites(
    ...args: Parameters<LunaLangGraphCheckpointer["putWrites"]>
  ): ReturnType<LunaLangGraphCheckpointer["putWrites"]> {
    if (this.#waitIsDurable() && !this.#injected) {
      this.#injected = true;
      throw new Error("LangGraph putWrites failed after durable wait");
    }
    await super.putWrites(...args);
  }
}

function faultHarness(): {
  readonly backends: RuntimeBackends;
  readonly checkpoints: CheckpointStore;
  readonly checkpointer: FaultAfterWaitCheckpointer;
} {
  const durableCheckpoints = createMemoryCheckpointStore();
  let waitIsDurable = false;
  const checkpoints: CheckpointStore = {
    ...durableCheckpoints,
    async saveWrites(writes) {
      await durableCheckpoints.saveWrites(writes);
      if (writes.some((write) => write.channel === WAIT_COMPLETION_CHANNEL)) {
        waitIsDurable = true;
      }
    }
  };
  return {
    checkpoints,
    checkpointer: new FaultAfterWaitCheckpointer(checkpoints, () => waitIsDurable),
    backends: langGraphInterruptBackends(checkpoints)
  };
}

describe("LangGraph interrupt wait authority", () => {
  it("keeps the durable wait resumable after a late putWrites failure", async () => {
      const runId = "run-langgraph-wait-putwrites";
      const harness = faultHarness();
      const failedState = vi.fn();
      const compiled = compileWorkflow({
        workflow: langGraphInterruptWorkflow,
        registry: langGraphInterruptRegistry
      });

      const waiting = await runCompiledWorkflow({
        compiled,
        workflow: langGraphInterruptWorkflow,
        invocation: {},
        config: {},
        run: {
          run_id: runId,
          workflow_id: langGraphInterruptWorkflow.id,
          attempt: 1,
          started_at: "2026-07-11T00:00:00.000Z"
        },
        backends: harness.backends,
        builtIns: { "runtime.pre": async () => ({ ready: true }) },
        agentRuntime: {} as AgentRuntimePort,
        langGraphCheckpointer: harness.checkpointer,
        onFailedState: failedState
      });

      expect(harness.checkpointer.injected).toBe(true);
      expect(waiting).toMatchObject({
        status: "waiting_for_input",
        interrupt_id: `interrupt-${runId}-approve`,
        checkpoint_id: `checkpoint-${runId}-approve`,
        state: {
          run_status: "waiting_for_input",
          steps: { pre: { ready: true } }
        }
      });
      expect(failedState).not.toHaveBeenCalled();
      await expect(harness.checkpoints.load(runId, {
        checkpointId: `terminal-${runId}-failed`,
        checkpointNs: ""
      })).resolves.toBeUndefined();
      expect((await harness.backends.events.list(runId)).filter(
        (event) => event.type === "run.failed" || event.type === "node.failed"
      )).toEqual([]);
      await expect(harness.backends.interrupts.get(
        `interrupt-${runId}-approve`
      )).resolves.toMatchObject({ status: "pending" });

      let downstreamRuns = 0;
      const resumed = await resumeCompiledWorkflow({
        compiled,
        workflow: langGraphInterruptWorkflow,
        checkpoint_id: `checkpoint-${runId}-approve`,
        thread_id: runId,
        interrupt_id: `interrupt-${runId}-approve`,
        decision: { approved: true },
        backends: harness.backends,
        builtIns: {
          "runtime.after": async () => {
            downstreamRuns += 1;
            return { done: true };
          }
        },
        agentRuntime: {} as AgentRuntimePort,
        langGraphCheckpointer: harness.checkpointer
      });

      expect(resumed).toMatchObject({
        status: "succeeded",
        state: {
          run_status: "succeeded",
          steps: {
            approve: { approved: true },
            after: { done: true }
          }
        }
      });
      expect(downstreamRuns).toBe(1);
  });

  it("isolates each SQLite scheduler journal from canonical resume state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-langgraph-journal-"));
    const artifactWorkflow: WorkflowDefinition = {
      ...langGraphInterruptWorkflow,
      id: "langgraph-wait-artifact-authority",
      graph: {
        nodes: langGraphInterruptWorkflow.graph.nodes.map((node) =>
          node.id !== "pre"
            ? node
            : {
                ...node,
                artifacts: [
                  {
                    path: "pre.json",
                    publisher: "artifacts.manifest_publisher",
                    source: { expression: "$.steps.pre" },
                    format: "json" as const,
                    required: true
                  }
                ]
              }
        )
      }
    };
    let publishCount = 0;
    const publisher: WorkflowArtifactPublisherPort = {
      async publish({ node_id, path: artifactPath }) {
        publishCount += 1;
        return {
          id: artifactPath,
          uri: `memory://${artifactPath}`,
          node_id
        };
      }
    };

    try {
      const checkpoints = createSqliteCheckpointStore({
        filePath: sqliteCheckpointFile(root)
      });
      const backends = langGraphInterruptBackends(checkpoints);
      const compiled = compileWorkflow({
        workflow: artifactWorkflow,
        registry: langGraphInterruptRegistry
      });
      const runId = "run-langgraph-sqlite-artifact";
      let preExecutions = 0;
      const runInput = {
        compiled,
        workflow: artifactWorkflow,
        invocation: {},
        config: {},
        run: {
          run_id: runId,
          workflow_id: artifactWorkflow.id,
          attempt: 1,
          started_at: "2026-07-11T00:00:00.000Z"
        },
        backends,
        builtIns: {
          "runtime.pre": async () => {
            preExecutions += 1;
            return { ready: true };
          }
        },
        artifactPublisher: publisher,
        agentRuntime: {} as AgentRuntimePort
      };
      const waiting = await runCompiledWorkflow({
        ...runInput,
        langGraphCheckpointer: new LunaLangGraphCheckpointer(checkpoints)
      });
      expect(waiting).toMatchObject({
        status: "waiting_for_input",
        state: {
          artifact_refs: [langGraphPreArtifact]
        }
      });
      if (waiting.status !== "waiting_for_input") {
        throw new Error("expected workflow to wait for input");
      }
      expect(preExecutions).toBe(1);
      expect(publishCount).toBe(1);

      const replayed = await runCompiledWorkflow({
        ...runInput,
        langGraphCheckpointer: new LunaLangGraphCheckpointer(checkpoints)
      });
      expect(replayed).toMatchObject({
        status: "waiting_for_input",
        interrupt_id: waiting.interrupt_id,
        checkpoint_id: waiting.checkpoint_id,
        state: {
          artifact_refs: [langGraphPreArtifact]
        }
      });
      if (replayed.status !== "waiting_for_input") {
        throw new Error("expected replayed workflow to remain waiting");
      }
      expect(preExecutions).toBe(1);
      expect(publishCount).toBe(1);
      await expect(checkpoints.load(runId, {
        checkpointId: `terminal-${runId}-failed`,
        checkpointNs: ""
      })).resolves.toBeUndefined();
      expect((await backends.events.list(runId)).filter(
        (event) => event.type === "run.failed"
      )).toEqual([]);

      const resumed = await resumeCompiledWorkflow({
        compiled,
        workflow: artifactWorkflow,
        checkpoint_id: replayed.checkpoint_id,
        thread_id: runId,
        interrupt_id: replayed.interrupt_id,
        decision: { approved: true },
        backends,
        builtIns: { "runtime.after": async () => ({ done: true }) },
        artifactPublisher: publisher,
        agentRuntime: {} as AgentRuntimePort,
        langGraphCheckpointer: new LunaLangGraphCheckpointer(checkpoints)
      });

      expect(resumed).toMatchObject({
        status: "succeeded",
        state: {
          artifact_refs: [langGraphPreArtifact]
        }
      });
      if (resumed.status !== "succeeded") {
        throw new Error("expected workflow to succeed after resume");
      }
      expect(resumed.state.artifact_refs).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
