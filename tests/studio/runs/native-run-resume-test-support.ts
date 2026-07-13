import type { InterruptRecord } from "../../../src/core/runtime/interrupts/contracts.js";
import { resumeInputsEqual } from "../../../src/core/runtime/interrupts/resume.js";
import {
  markNodeWaitingForInput,
  startNodeAttempt,
  succeedNode
} from "../../../src/core/runtime/lifecycle.js";
import {
  createInitialRuntimeState,
  type LunaRuntimeState
} from "../../../src/core/runtime/state.js";
import { officialCapabilityManifests } from "../../../src/capabilities/registry.js";
import { loadNativeRunContext } from "../../../src/platform/native/native-run-context.js";
import {
  createNativeLunaPlatformRegistrations,
  nativeLunaPlatformRegistrations
} from "../../../src/platform/native/native-platform-registrations.js";
import type { NativeStudioRunDispatcher } from "../../../src/studio/adapters/native/run-dispatcher.js";
import { BASE_TIME } from "./native-run-launch-test-support.js";

export function interruptRecord(runId: string): InterruptRecord {
  const createdAt = new Date(BASE_TIME + 10_000).toISOString();
  return {
    id: "interrupt-1",
    run_id: runId,
    thread_id: "thread-1",
    checkpoint_id: "checkpoint-1",
    node_id: "analyze",
    status: "pending",
    created_at: createdAt,
    updated_at: createdAt,
    payload: {
      interrupt_id: "interrupt-1",
      run: {
        run_id: runId,
        workflow_id: "pinned-workflow",
        attempt: 1,
        started_at: new Date(BASE_TIME).toISOString(),
        source: "studio",
        event: "manual",
        target: { type: "workflow", id: "pinned-workflow" }
      },
      checkpoint_id: "checkpoint-1",
      node_id: "analyze",
      kind: "human_gate",
      prompt: "Review",
      decisions: [],
      created_at: createdAt
    }
  };
}

export function interruptPort(interrupts: Map<string, InterruptRecord>) {
  return {
    get: async (id: string) => interrupts.get(id),
    beginResume: async (
      id: string,
      resumeAttempt: string,
      input: NonNullable<InterruptRecord["resume_input"]>
    ) => {
      const current = interrupts.get(id);
      if (current === undefined) throw new Error("interrupt missing");
      if (current.status === "resuming") {
        if (
          current.resume_attempt !== resumeAttempt ||
          current.resume_input === undefined ||
          !resumeInputsEqual(current.resume_input, input)
        ) {
          throw new Error("interrupt resume claim conflict");
        }
        return {
          interrupt_id: id,
          resume_attempt: resumeAttempt,
          status: "claimed" as const
        };
      }
      if (current.status !== "pending") {
        throw new Error("interrupt cannot accept resume claim");
      }
      interrupts.set(id, {
        ...current,
        status: "resuming",
        resume_attempt: resumeAttempt,
        resume_input: input
      });
      return {
        interrupt_id: id,
        resume_attempt: resumeAttempt,
        status: "claimed" as const
      };
    },
    completeResume: async (
      id: string,
      claim: { readonly resume_attempt: string },
      status: "resolved" | "cancelled",
      resume?: NonNullable<InterruptRecord["resume"]>
    ) => {
      const current = interrupts.get(id);
      if (
        current === undefined ||
        current.status !== "resuming" ||
        current.resume_attempt !== claim.resume_attempt
      ) {
        throw new Error("interrupt resume claim mismatch");
      }
      interrupts.set(id, {
        ...current,
        status,
        resume_input: undefined,
        ...(resume === undefined ? {} : { resume })
      });
    }
  };
}

export function driftedCapabilityPlatform() {
  const [firstManifest, ...remainingManifests] = officialCapabilityManifests;
  if (firstManifest === undefined) {
    throw new Error("Expected official capabilities");
  }
  return createNativeLunaPlatformRegistrations({
    baseCapabilityManifests: [
      { ...firstManifest, version: "999.0.0" },
      ...remainingManifests
    ]
  });
}

export async function waitingResult(
  input: Parameters<
    ConstructorParameters<typeof NativeStudioRunDispatcher>[0]["runWorkflow"]
  >[0]
) {
  if (input.run === undefined) throw new Error("Expected preallocated run");
  const context = await loadNativeRunContext(input, {
    platform: nativeLunaPlatformRegistrations
  });
  await input.onCompiledWorkflow?.(context.nativeWorkflow.compiled);
  let state = createInitialRuntimeState({
    invocation: input.invocation,
    config: input.workflowConfig ?? {},
    run: input.run,
    workflow: { id: "pinned-workflow", mode: "read_only" }
  });
  state = startNodeAttempt(state, "analyze", 1);
  state = markNodeWaitingForInput(state, "analyze");
  return {
    status: "waiting_for_input" as const,
    interrupt_id: "interrupt-1",
    checkpoint_id: "checkpoint-1",
    state
  };
}

export function succeededResumeState(
  waiting: LunaRuntimeState
): LunaRuntimeState {
  const analyzing = waiting.node_statuses.analyze;
  if (analyzing === undefined) throw new Error("Missing analyze node");
  const running: LunaRuntimeState = {
    ...waiting,
    run_status: "running",
    node_statuses: {
      ...waiting.node_statuses,
      analyze: { ...analyzing, status: "running" }
    }
  };
  return { ...succeedNode(running, "analyze"), run_status: "succeeded" };
}
