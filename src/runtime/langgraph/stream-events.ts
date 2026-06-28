import {
  validateCheckpointState,
  type LunaRuntimeState
} from "../../core/runtime/state.js";
import type { WorkflowRuntimeStreamEvent } from "../workflow/stream-observer.js";

export type LangGraphProtocolEvent = {
  readonly type: "event";
  readonly method: string;
  readonly params: {
    readonly namespace: readonly string[];
    readonly timestamp: number;
    readonly node?: string;
    readonly data: unknown;
  };
};

export type LangGraphEventProjection = {
  readonly state?: LunaRuntimeState;
  readonly event?: WorkflowRuntimeStreamEvent;
};

export function projectLangGraphProtocolEvent(
  event: unknown
): LangGraphEventProjection {
  if (!isProtocolEvent(event)) {
    return {};
  }

  if (event.method === "values") {
    return {
      event: {
        kind: "runtime_event",
        channel: event.method,
        nodeId: event.params.node,
        namespace: event.params.namespace
      }
    };
  }

  if (event.method === "updates") {
    return {
      event: {
        kind: "update",
        nodeIds: event.params.node === undefined
          ? objectKeys(event.params.data)
          : [event.params.node]
      }
    };
  }

  if (event.method === "checkpoints") {
    return {
      event: {
        kind: "checkpoint",
        checkpointId: checkpointIdFromPayload(event.params.data),
        nextNodeIds: nextNodeIdsFromPayload(event.params.data)
      }
    };
  }

  if (event.method === "tasks") {
    return { event: taskStreamEventFromPayload(event.params.data, event.params.node) };
  }

  if (event.method === "lifecycle") {
    return {
      event: {
        kind: "runtime_event",
        channel: event.method,
        nodeId: event.params.node,
        namespace: event.params.namespace
      }
    };
  }

  return {};
}

export function assertLangGraphOutputState(output: unknown): LunaRuntimeState {
  validateCheckpointState(output);
  return output as LunaRuntimeState;
}

function isProtocolEvent(value: unknown): value is LangGraphProtocolEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const event = value as { readonly type?: unknown; readonly method?: unknown; readonly params?: unknown };
  if (event.type !== "event" || typeof event.method !== "string") {
    return false;
  }
  if (event.params === null || typeof event.params !== "object" || Array.isArray(event.params)) {
    return false;
  }
  const params = event.params as {
    readonly namespace?: unknown;
    readonly timestamp?: unknown;
  };
  return Array.isArray(params.namespace) && typeof params.timestamp === "number";
}

function objectKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value);
}

function checkpointIdFromPayload(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const config = (payload as { readonly config?: unknown }).config;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  const configurable = (config as { readonly configurable?: unknown }).configurable;
  if (
    configurable === null ||
    typeof configurable !== "object" ||
    Array.isArray(configurable)
  ) {
    return undefined;
  }
  const checkpointId = (configurable as { readonly checkpoint_id?: unknown }).checkpoint_id;
  return typeof checkpointId === "string" && checkpointId !== ""
    ? checkpointId
    : undefined;
}

function nextNodeIdsFromPayload(payload: unknown): string[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const next = (payload as { readonly next?: unknown }).next;
  if (!Array.isArray(next)) {
    return [];
  }
  return next.filter((item): item is string => typeof item === "string");
}

function taskStreamEventFromPayload(
  payload: unknown,
  fallbackNodeId: string | undefined
): WorkflowRuntimeStreamEvent {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      kind: "task",
      nodeId: fallbackNodeId,
      phase: "started",
      interruptCount: 0
    };
  }
  const task = payload as {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly interrupts?: unknown;
    readonly result?: unknown;
  };
  return {
    kind: "task",
    taskId: typeof task.id === "string" && task.id !== "" ? task.id : undefined,
    nodeId: typeof task.name === "string" && task.name !== ""
      ? task.name
      : fallbackNodeId,
    phase: Array.isArray(task.result) ? "finished" : "started",
    interruptCount: Array.isArray(task.interrupts) ? task.interrupts.length : 0
  };
}
