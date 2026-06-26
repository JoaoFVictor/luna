import { describe, expect, it } from "vitest";
import { createInterrupt } from "../../../src/core/runtime/interrupts/resume.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import type { RunHandle } from "../../../src/core/runtime/run-handle.js";

const run = {
  run_id: "run-1",
  workflow_id: "workflow-1",
  attempt: 1,
  started_at: "2026-06-26T10:00:00.000Z"
} satisfies RunHandle;

describe("runtime interrupts", () => {
  it("creates the exact interrupt payload shape and writes a create event", async () => {
    const interrupts = createMemoryInterruptStore();
    const events = createMemoryEventStore();

    const interrupt = await createInterrupt(
      {
        interrupt_id: "interrupt-1",
        run,
        checkpoint_id: "checkpoint-1",
        node_id: "approval",
        kind: "human_approval",
        prompt: "Approve deployment?",
        decisions: ["approve", "reject"],
        created_at: "2026-06-26T10:01:00.000Z",
        expires_at: "2026-06-26T11:01:00.000Z"
      },
      {
        threadId: "thread-1",
        interruptStore: interrupts,
        eventStore: events
      }
    );

    expect(interrupt).toEqual({
      interrupt_id: "interrupt-1",
      run,
      checkpoint_id: "checkpoint-1",
      node_id: "approval",
      kind: "human_approval",
      prompt: "Approve deployment?",
      decisions: ["approve", "reject"],
      created_at: "2026-06-26T10:01:00.000Z",
      expires_at: "2026-06-26T11:01:00.000Z"
    });

    await expect(interrupts.get("interrupt-1")).resolves.toMatchObject({
      id: "interrupt-1",
      run_id: "run-1",
      thread_id: "thread-1",
      checkpoint_id: "checkpoint-1",
      node_id: "approval",
      status: "pending",
      payload: interrupt
    });

    await expect(events.list("run-1")).resolves.toMatchObject([
      {
        interrupt_id: "interrupt-1",
        node_id: "approval",
        type: "luna.interrupt.created",
        data: {
          checkpoint_id: "checkpoint-1",
          kind: "human_approval"
        }
      }
    ]);
  });
});
