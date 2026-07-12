import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import type { InterruptStore } from "../../../src/core/runtime/interrupts/contracts.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import {
  resumeCompiledWorkflow,
  runCompiledWorkflow
} from "../../../src/runtime/langgraph/workflow-runner.js";
import { runnerBackends } from "./runner-test-support.js";
import {
  interruptWaitRecoveryRegistry,
  interruptWaitRecoveryWorkflow
} from "./interrupt-wait-recovery-test-support.js";

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("workflow run and resume lease", () => {
  it("serializes an exact run behind an in-flight downstream resume", async () => {
    const definition: WorkflowDefinition = {
      ...interruptWaitRecoveryWorkflow,
      id: "run-resume-concurrency",
      graph: {
        nodes: [
          ...interruptWaitRecoveryWorkflow.graph.nodes,
          {
            id: "after",
            type: "built_in",
            uses: "runtime.after",
            after: ["approve"]
          }
        ]
      }
    };
    const compiled = compileWorkflow({
      workflow: definition,
      registry: interruptWaitRecoveryRegistry
    });
    const stores = runnerBackends();
    const durableInterrupts = stores.interrupts;
    const exactRunQueued = deferred();
    let leaseAttempts = 0;
    let leaseEntries = 0;
    const interrupts: InterruptStore = {
      ...durableInterrupts,
      async withResumeLease(runId, operation) {
        leaseAttempts += 1;
        if (leaseAttempts === 2) {
          exactRunQueued.resolve();
        }
        return await durableInterrupts.withResumeLease(runId, async () => {
          leaseEntries += 1;
          return await operation();
        });
      }
    };
    stores.interrupts = interrupts;
    const runId = "run-run-resume-concurrency";
    const run = {
      run_id: runId,
      workflow_id: definition.id,
      attempt: 1,
      started_at: "2026-07-11T00:00:00.000Z"
    };
    const executePre = vi.fn(async () => ({ ready: true }));
    const waiting = await runCompiledWorkflow({
      compiled,
      workflow: definition,
      invocation: {},
      config: {},
      run,
      backends: stores,
      builtIns: { "runtime.pre": executePre },
      agentRuntime: {} as AgentRuntimePort
    });
    if (waiting.status !== "waiting_for_input") {
      throw new Error("Expected the workflow to wait for input");
    }
    leaseAttempts = 0;
    leaseEntries = 0;

    const downstreamEntered = deferred();
    const releaseDownstream = deferred();
    const executeDownstream = vi.fn(async () => {
      downstreamEntered.resolve();
      await releaseDownstream.promise;
      return { done: true };
    });
    const resume = resumeCompiledWorkflow({
      compiled,
      workflow: definition,
      checkpoint_id: waiting.checkpoint_id,
      thread_id: runId,
      interrupt_id: waiting.interrupt_id,
      decision: { approved: true },
      backends: stores,
      builtIns: { "runtime.after": executeDownstream },
      agentRuntime: {} as AgentRuntimePort
    });
    await downstreamEntered.promise;

    const exactRun = runCompiledWorkflow({
      compiled,
      workflow: definition,
      invocation: {},
      config: {},
      run,
      backends: stores,
      builtIns: {
        "runtime.pre": executePre,
        "runtime.after": executeDownstream
      },
      agentRuntime: {} as AgentRuntimePort
    }).catch((cause: unknown) => cause);
    await exactRunQueued.promise;

    try {
      expect(leaseEntries).toBe(1);
      expect(executePre).toHaveBeenCalledTimes(1);
      expect(executeDownstream).toHaveBeenCalledTimes(1);
    } finally {
      releaseDownstream.resolve();
    }

    await expect(resume).resolves.toMatchObject({ status: "succeeded" });
    await expect(exactRun).resolves.toMatchObject({
      code: "runtime_state_invalid",
      details: { run_status: "succeeded", thread_id: runId }
    });
    expect(leaseEntries).toBe(2);
    expect(executePre).toHaveBeenCalledTimes(1);
    expect(executeDownstream).toHaveBeenCalledTimes(1);
  });
});
