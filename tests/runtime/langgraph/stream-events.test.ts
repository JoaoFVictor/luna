import { describe, expect, it } from "vitest";
import { projectLangGraphProtocolEvent } from "../../../src/runtime/langgraph/stream-events.js";

describe("LangGraph stream event projection", () => {
  it("projects v3 runtime events without leaking protocol terminology into the neutral event", () => {
    const projected = projectLangGraphProtocolEvent({
      type: "event",
      method: "values",
      params: {
        namespace: ["workflow", "node"],
        timestamp: 1,
        node: "review",
        data: {}
      }
    });

    expect(projected.event).toEqual({
      kind: "runtime_event",
      channel: "values",
      nodeId: "review",
      namespace: ["workflow", "node"]
    });
  });

  it("projects checkpoint and task payloads into neutral stream events", () => {
    expect(
      projectLangGraphProtocolEvent({
        type: "event",
        method: "checkpoints",
        params: {
          namespace: [],
          timestamp: 1,
          data: {
            config: { configurable: { checkpoint_id: "checkpoint-1" } },
            next: ["approve"]
          }
        }
      }).event
    ).toEqual({
      kind: "checkpoint",
      checkpointId: "checkpoint-1",
      nextNodeIds: ["approve"]
    });

    expect(
      projectLangGraphProtocolEvent({
        type: "event",
        method: "tasks",
        params: {
          namespace: [],
          timestamp: 1,
          node: "approve",
          data: {
            id: "task-1",
            name: "approve",
            interrupts: [{ value: "waiting" }],
            result: []
          }
        }
      }).event
    ).toEqual({
      kind: "task",
      taskId: "task-1",
      nodeId: "approve",
      phase: "finished",
      interruptCount: 1
    });
  });

  it("ignores unknown shapes and unsupported stream methods", () => {
    expect(projectLangGraphProtocolEvent({})).toEqual({});
    expect(
      projectLangGraphProtocolEvent({
        type: "event",
        method: "custom",
        params: { namespace: [], timestamp: 1, data: {} }
      })
    ).toEqual({});
  });
});
