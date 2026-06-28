import { describe, expect, it } from "vitest";
import { createInterrupt, resumeInterrupt } from "../../../src/core/runtime/interrupts/resume.js";
import { allowInterruptResume } from "../../../src/core/runtime/interrupts/authorization.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import type { InterruptStore } from "../../../src/core/runtime/interrupts/contracts.js";
import type { RunHandle } from "../../../src/core/runtime/run-handle.js";

const run = {
  run_id: "run-1",
  workflow_id: "workflow-1",
  attempt: 1,
  started_at: "2026-06-26T10:00:00.000Z"
} satisfies RunHandle;

async function pendingInterrupt(
  overrides: Partial<Parameters<typeof createInterrupt>[0]> = {},
  options: {
    threadId?: string;
    interruptStore?: InterruptStore;
  } = {}
) {
  const interrupts = options.interruptStore ?? createMemoryInterruptStore();
  const events = createMemoryEventStore();
  await createInterrupt(
    {
      interrupt_id: "interrupt-1",
      run,
      checkpoint_id: "checkpoint-1",
      node_id: "approval",
      kind: "human_approval",
      prompt: "Approve deployment?",
      decisions: ["approve", "reject"],
      created_at: "2026-06-26T10:01:00.000Z",
      ...overrides
    },
    {
      threadId: options.threadId ?? "thread-1",
      interruptStore: interrupts,
      eventStore: events
    }
  );

  return { interrupts, events };
}

describe("runtime interrupt resume authorization", () => {
  it("resumes once, records an event, and returns the previous decision for exact duplicates", async () => {
    const { interrupts, events } = await pendingInterrupt();
    const input = {
      interrupt_id: "interrupt-1",
      thread_id: "thread-1",
      checkpoint_id: "checkpoint-1",
      decision: "approve",
      payload: { comment: "ship it" },
      actor: { id: "user-1" }
    };

    const first = await resumeInterrupt(input, {
      interruptStore: interrupts,
      eventStore: events,
      authorization: allowInterruptResume(),
      now: () => "2026-06-26T10:02:00.000Z",
      resumeId: () => "resume-1"
    });
    const duplicate = await resumeInterrupt(input, {
      interruptStore: interrupts,
      eventStore: events,
      authorization: allowInterruptResume(),
      now: () => "2026-06-26T10:03:00.000Z",
      resumeId: () => "resume-duplicate"
    });

    expect(first).toMatchObject({
      interrupt_id: "interrupt-1",
      resume_id: "resume-1",
      decision: "approve",
      already_resumed: false
    });
    expect(duplicate).toMatchObject({
      interrupt_id: "interrupt-1",
      resume_id: "resume-1",
      decision: "approve",
      already_resumed: true
    });
    await expect(interrupts.get("interrupt-1")).resolves.toMatchObject({
      status: "resolved",
      resume: {
        resume_id: "resume-1",
        input
      }
    });
  });

  it("rejects duplicate resumes with different payload as interrupt_conflict", async () => {
    const { interrupts, events } = await pendingInterrupt();
    const baseInput = {
      interrupt_id: "interrupt-1",
      thread_id: "thread-1",
      checkpoint_id: "checkpoint-1",
      decision: "approve",
      payload: { comment: "ship it" },
      actor: { id: "user-1" }
    };

    await resumeInterrupt(baseInput, {
      interruptStore: interrupts,
      eventStore: events,
      authorization: allowInterruptResume(),
      now: () => "2026-06-26T10:02:00.000Z",
      resumeId: () => "resume-1"
    });

    await expect(
      resumeInterrupt(
        { ...baseInput, payload: { comment: "hold" } },
        {
          interruptStore: interrupts,
          eventStore: events,
          authorization: allowInterruptResume()
        }
      )
    ).rejects.toMatchObject({ code: "interrupt_conflict" });
  });

  it("rejects stale resumes with mismatched thread or checkpoint", async () => {
    const { interrupts, events } = await pendingInterrupt();

    await expect(
      resumeInterrupt(
        {
          interrupt_id: "interrupt-1",
          thread_id: "thread-2",
          checkpoint_id: "checkpoint-1",
          decision: "approve"
        },
        {
          interruptStore: interrupts,
          eventStore: events,
          authorization: allowInterruptResume()
        }
      )
    ).rejects.toMatchObject({ code: "interrupt_stale" });

  });

  it("rejects expired interrupts unless the expiration policy allows extension", async () => {
    const { interrupts, events } = await pendingInterrupt({
      expires_at: "2026-06-26T10:01:30.000Z"
    });
    const input = {
      interrupt_id: "interrupt-1",
      thread_id: "thread-1",
      checkpoint_id: "checkpoint-1",
      decision: "approve"
    };

    await expect(
      resumeInterrupt(input, {
        interruptStore: interrupts,
        eventStore: events,
        authorization: allowInterruptResume(),
        now: () => "2026-06-26T10:02:00.000Z"
      })
    ).rejects.toMatchObject({ code: "interrupt_expired" });

    await expect(
      resumeInterrupt(input, {
        interruptStore: interrupts,
        eventStore: events,
        authorization: allowInterruptResume(),
        expirationPolicy: {
          allowExpiredResume: () => true
        },
        now: () => "2026-06-26T10:02:00.000Z",
        resumeId: () => "resume-extended"
      })
    ).resolves.toMatchObject({
      resume_id: "resume-extended",
      decision: "approve"
    });
  });

  it("rejects unsupported concurrent interrupt merge before mutating state", async () => {
    const interrupts = createMemoryInterruptStore();
    const events = createMemoryEventStore();
    await pendingInterrupt({ interrupt_id: "interrupt-1" }, { interruptStore: interrupts });
    await createInterrupt(
      {
        interrupt_id: "interrupt-2",
        run,
        checkpoint_id: "checkpoint-1",
        node_id: "second-approval",
        kind: "human_approval",
        prompt: "Second approval?",
        decisions: ["approve", "reject"],
        created_at: "2026-06-26T10:01:30.000Z"
      },
      {
        threadId: "thread-1",
        interruptStore: interrupts,
        eventStore: events
      }
    );

    await expect(
      resumeInterrupt(
        {
          interrupt_id: "interrupt-1",
          thread_id: "thread-1",
          checkpoint_id: "checkpoint-1",
          decision: "approve"
        },
        {
          interruptStore: interrupts,
          eventStore: events,
          authorization: allowInterruptResume()
        }
      )
    ).rejects.toMatchObject({ code: "interrupt_concurrent_merge_unsupported" });

    await expect(interrupts.get("interrupt-1")).resolves.toMatchObject({ status: "pending" });
    await expect(events.query({ runId: "run-1", interruptId: "interrupt-1" })).resolves.toEqual([]);
  });

  it("rejects unauthorized resumes before mutating state", async () => {
    const { interrupts, events } = await pendingInterrupt();

    await expect(
      resumeInterrupt(
        {
          interrupt_id: "interrupt-1",
          thread_id: "thread-1",
          checkpoint_id: "checkpoint-1",
          decision: "approve"
        },
        {
          interruptStore: interrupts,
          eventStore: events,
          authorization: {
            authorizeResume: async () => ({
              allowed: false,
              reason: "actor cannot approve this interrupt"
            })
          }
        }
      )
    ).rejects.toMatchObject({ code: "interrupt_unauthorized" });

    await expect(interrupts.get("interrupt-1")).resolves.toMatchObject({ status: "pending" });
  });
});
