import { describe, expect, it } from "vitest";
import { persistedNodeDurability } from "../../../src/runtime/workflow/node-durability.js";

describe("persisted node durability", () => {
  it("rejects foreign writes inside a node-owned checkpoint", () => {
    expect(() =>
      persistedNodeDurability({
        nodeId: "second",
        writes: [
          {
            thread_id: "run-1",
            checkpoint_ns: "",
            checkpoint_id: "node-output-second",
            task_id: "second",
            index: 0,
            channel: "steps",
            value: { canonical: true }
          },
          {
            thread_id: "run-1",
            checkpoint_ns: "",
            checkpoint_id: "node-output-second",
            task_id: "first",
            index: 9,
            channel: "steps",
            value: { injected: true }
          }
        ]
      })
    ).toThrow(
      expect.objectContaining({
        code: "runtime_state_invalid",
        details: expect.objectContaining({
          node_id: "second",
          write_task_id: "first",
          write_index: 9,
          write_channel: "steps"
        })
      })
    );
  });
});
