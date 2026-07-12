import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import type { CheckpointStore } from "../../../src/core/runtime/backends/contracts.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { LunaLangGraphCheckpointer } from "../../../src/runtime/backends/sqlite/langgraph-checkpointer.js";
import { runCompiledWorkflow } from "../../../src/runtime/langgraph/workflow-runner.js";
import {
  langGraphInterruptBackends,
  langGraphInterruptRegistry,
  langGraphInterruptWorkflow
} from "./langgraph-interrupt-test-support.js";

const NODE_COMPLETION_CHANNEL = "node_completion";
const INTERNAL_THREAD_PREFIX = "luna_scheduler_";

function faultAfterNodeCompletion(): {
  readonly checkpoints: CheckpointStore;
  readonly durable: CheckpointStore;
  readonly faulted: () => boolean;
} {
  const durable = createMemoryCheckpointStore();
  let completionDurable = false;
  let faulted = false;
  const failJournalAfterCompletion = (threadIds: readonly string[]): void => {
    if (
      completionDurable &&
      !faulted &&
      threadIds.some((threadId) => threadId.startsWith(INTERNAL_THREAD_PREFIX))
    ) {
      faulted = true;
      throw new Error("auxiliary LangGraph journal response lost after node completion");
    }
  };
  const checkpoints: CheckpointStore = {
    ...durable,
    async save(input) {
      const saved = await durable.save(input);
      failJournalAfterCompletion([input.thread_id]);
      return saved;
    },
    async saveWrites(writes) {
      await durable.saveWrites(writes);
      if (writes.some((write) => write.channel === NODE_COMPLETION_CHANNEL)) {
        completionDurable = true;
      }
      failJournalAfterCompletion(writes.map((write) => write.thread_id));
    }
  };

  return { checkpoints, durable, faulted: () => faulted };
}

describe("LangGraph auxiliary checkpoint recovery", () => {
  it("replays exact completed nodes instead of writing a failed terminal", async () => {
    const definition: WorkflowDefinition = {
      ...langGraphInterruptWorkflow,
      id: "langgraph-auxiliary-journal-recovery",
      capabilities: ["runtime"],
      graph: {
        nodes: [{ id: "pre", type: "built_in", uses: "runtime.pre" }]
      }
    };
    const compiled = compileWorkflow({
      workflow: definition,
      registry: langGraphInterruptRegistry
    });
    const fault = faultAfterNodeCompletion();
    const backends = langGraphInterruptBackends(fault.checkpoints);
    const runId = "run-langgraph-auxiliary-recovery";
    const failedState = vi.fn();
    let executions = 0;
    const runInput = {
      compiled,
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: runId,
        workflow_id: definition.id,
        attempt: 1,
        started_at: "2026-07-11T00:00:00.000Z"
      },
      backends,
      builtIns: {
        "runtime.pre": async () => {
          executions += 1;
          return { ready: true };
        }
      },
      agentRuntime: {} as AgentRuntimePort,
      onFailedState: failedState
    };

    await expect(runCompiledWorkflow({
      ...runInput,
      langGraphCheckpointer: new LunaLangGraphCheckpointer(fault.checkpoints)
    })).rejects.toMatchObject({ code: "runtime_durability_recovery_required" });
    expect(fault.faulted()).toBe(true);
    expect(executions).toBe(1);
    expect(failedState).not.toHaveBeenCalled();
    await expect(fault.durable.load(runId, {
      checkpointId: `terminal-${runId}-failed`,
      checkpointNs: ""
    })).resolves.toBeUndefined();
    expect((await backends.events.list(runId)).filter(
      (event) => event.type === "run.failed" || event.type === "node.failed"
    )).toEqual([]);
    await expect(runCompiledWorkflow({
      ...runInput,
      langGraphCheckpointer: new LunaLangGraphCheckpointer(fault.checkpoints)
    })).resolves.toMatchObject({
      status: "succeeded",
      state: {
        run_status: "succeeded",
        steps: { pre: { ready: true } }
      }
    });
    expect(executions).toBe(1);
    expect(failedState).not.toHaveBeenCalled();
  });
});
