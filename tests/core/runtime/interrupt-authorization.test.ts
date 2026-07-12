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
  it("keeps a pending interrupt authoritative when its event projection fails", async () => {
    const interrupts = createMemoryInterruptStore();
    const eventFailure = new Error("event projection unavailable");

    await expect(createInterrupt(
      {
        interrupt_id: "interrupt-event-failure",
        run,
        checkpoint_id: "checkpoint-event-failure",
        node_id: "approval",
        kind: "human_approval",
        prompt: "Approve?",
        decisions: ["approve"],
        created_at: "2026-06-26T10:01:00.000Z"
      },
      {
        threadId: "thread-1",
        interruptStore: interrupts,
        eventStore: {
          ...createMemoryEventStore(),
          async append() {
            throw eventFailure;
          }
        }
      }
    )).resolves.toMatchObject({ interrupt_id: "interrupt-event-failure" });
    await expect(interrupts.get("interrupt-event-failure"))
      .resolves.toMatchObject({ status: "pending" });
  });

  it("adopts an exact interrupt create that committed before throwing", async () => {
    const interrupts = createMemoryInterruptStore();
    const createFailure = new Error("interrupt store close failed");

    await expect(createInterrupt(
      {
        interrupt_id: "interrupt-acceptance-unknown",
        run,
        checkpoint_id: "checkpoint-acceptance-unknown",
        node_id: "approval",
        kind: "human_approval",
        prompt: "Approve?",
        decisions: ["approve"],
        created_at: "2026-06-26T10:01:00.000Z"
      },
      {
        threadId: "thread-1",
        interruptStore: {
          ...interrupts,
          async create(record) {
            await interrupts.create(record);
            throw createFailure;
          }
        },
        eventStore: createMemoryEventStore()
      }
    )).resolves.toMatchObject({ interrupt_id: "interrupt-acceptance-unknown" });
    await expect(interrupts.get("interrupt-acceptance-unknown"))
      .resolves.toMatchObject({ status: "pending" });
  });

  it("keeps an exact resolved resume authoritative across store and event failures", async () => {
    const interrupts = createMemoryInterruptStore();
    await pendingInterrupt({}, { interruptStore: interrupts });
    const completionFailure = new Error("interrupt store close failed");
    const eventFailure = new Error("resume event projection unavailable");
    const acceptanceUnknownStore: InterruptStore = {
      ...interrupts,
      async completeResume(id, claim, status, resume) {
        await interrupts.completeResume(id, claim, status, resume);
        throw completionFailure;
      }
    };

    await expect(resumeInterrupt(
      {
        interrupt_id: "interrupt-1",
        thread_id: "thread-1",
        checkpoint_id: "checkpoint-1",
        decision: "approve"
      },
      {
        interruptStore: acceptanceUnknownStore,
        eventStore: {
          ...createMemoryEventStore(),
          async append() {
            throw eventFailure;
          }
        },
        authorization: allowInterruptResume(),
        now: () => "2026-06-26T10:02:00.000Z",
        resumeId: () => "resume-acceptance-unknown"
      }
    )).resolves.toMatchObject({
      resume_id: "resume-acceptance-unknown",
      decision: "approve",
      already_resumed: false
    });
    await expect(interrupts.get("interrupt-1")).resolves.toMatchObject({
      status: "resolved",
      resume: { resume_id: "resume-acceptance-unknown" }
    });
  });

  it("adopts an exact durable begin-resume claim after the store loses its response", async () => {
    const interrupts = createMemoryInterruptStore();
    const { events } = await pendingInterrupt({}, { interruptStore: interrupts });
    const beginFailure = new Error("begin-resume response lost after commit");
    const acceptanceUnknownStore: InterruptStore = {
      ...interrupts,
      async beginResume(id, resumeAttempt, input) {
        await interrupts.beginResume(id, resumeAttempt, input);
        throw beginFailure;
      }
    };

    await expect(resumeInterrupt(
      {
        interrupt_id: "interrupt-1",
        thread_id: "thread-1",
        checkpoint_id: "checkpoint-1",
        decision: "approve"
      },
      {
        interruptStore: acceptanceUnknownStore,
        eventStore: events,
        authorization: allowInterruptResume(),
        now: () => "2026-06-26T10:02:00.000Z",
        resumeId: () => "resume-begin-acceptance-unknown"
      }
    )).resolves.toMatchObject({
      resume_id: "resume-begin-acceptance-unknown",
      already_resumed: false
    });
    await expect(interrupts.get("interrupt-1")).resolves.toMatchObject({
      status: "resolved",
      resume: { resume_id: "resume-begin-acceptance-unknown" }
    });
  });

  it.each(["begin", "complete"] as const)(
    "requires recovery when %s-resume commits but exact readback is unavailable",
    async (phase) => {
      const interrupts = createMemoryInterruptStore();
      const { events } = await pendingInterrupt({}, { interruptStore: interrupts });
      let rejectReadback = false;
      const responseLost = new Error(`${phase}-resume response lost after commit`);
      const readbackLost = new Error(`${phase}-resume exact readback unavailable`);
      const acceptanceUnknownStore: InterruptStore = {
        ...interrupts,
        async get(id) {
          if (rejectReadback) {
            rejectReadback = false;
            throw readbackLost;
          }
          return await interrupts.get(id);
        },
        async beginResume(id, resumeAttempt, input) {
          const claim = await interrupts.beginResume(id, resumeAttempt, input);
          if (phase === "begin") {
            rejectReadback = true;
            throw responseLost;
          }
          return claim;
        },
        async completeResume(id, claim, status, resume) {
          await interrupts.completeResume(id, claim, status, resume);
          if (phase === "complete") {
            rejectReadback = true;
            throw responseLost;
          }
        }
      };
      const input = {
        interrupt_id: "interrupt-1",
        thread_id: "thread-1",
        checkpoint_id: "checkpoint-1",
        decision: "approve"
      };
      const options = {
        interruptStore: acceptanceUnknownStore,
        eventStore: events,
        authorization: allowInterruptResume(),
        now: () => "2026-06-26T10:02:00.000Z",
        resumeId: () => `resume-${phase}-readback-unknown`
      };

      await expect(resumeInterrupt(input, options)).rejects.toMatchObject({
        code: "runtime_durability_recovery_required",
        details: { transition: `${phase}_resume` }
      });
      await expect(resumeInterrupt(input, options)).resolves.toMatchObject({
        resume_id: `resume-${phase}-readback-unknown`
      });
      await expect(interrupts.get("interrupt-1")).resolves.toMatchObject({
        status: "resolved"
      });
    }
  );

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

  it("adopts an exact durable resume claim after expiration without reauthorizing it", async () => {
    const interrupts = createMemoryInterruptStore();
    const { events } = await pendingInterrupt(
      { expires_at: "2026-06-26T10:01:30.000Z" },
      { interruptStore: interrupts }
    );
    const completionFailure = new Error("process stopped before completion");
    let failCompletion = true;
    const crashRecoverableStore: InterruptStore = {
      ...interrupts,
      async completeResume(id, claim, status, resume) {
        if (failCompletion) {
          failCompletion = false;
          throw completionFailure;
        }
        await interrupts.completeResume(id, claim, status, resume);
      }
    };
    const input = {
      interrupt_id: "interrupt-1",
      thread_id: "thread-1",
      checkpoint_id: "checkpoint-1",
      decision: "approve",
      actor: { id: "approver-1" }
    };

    await expect(resumeInterrupt(input, {
      interruptStore: crashRecoverableStore,
      eventStore: events,
      authorization: allowInterruptResume(),
      now: () => "2026-06-26T10:01:15.000Z",
      resumeId: () => "resume-durable-claim"
    })).rejects.toBe(completionFailure);
    await expect(interrupts.get("interrupt-1")).resolves.toMatchObject({
      status: "resuming",
      resume_attempt: "resume-durable-claim",
      resume_input: input
    });

    await expect(resumeInterrupt(
      { ...input, decision: "reject" },
      {
        interruptStore: crashRecoverableStore,
        eventStore: events,
        now: () => "2026-06-26T10:02:00.000Z"
      }
    )).rejects.toMatchObject({ code: "interrupt_conflict" });

    await expect(resumeInterrupt(input, {
      interruptStore: crashRecoverableStore,
      eventStore: events,
      authorization: {
        authorizeResume: async () => ({
          allowed: false,
          reason: "policy changed after the durable claim"
        })
      },
      now: () => "2026-06-26T10:02:00.000Z",
      resumeId: () => "resume-must-not-replace-the-claim"
    })).resolves.toMatchObject({
      resume_id: "resume-durable-claim",
      decision: "approve",
      already_resumed: false
    });
    await expect(interrupts.get("interrupt-1")).resolves.toMatchObject({
      status: "resolved",
      resume: {
        resume_id: "resume-durable-claim",
        input
      }
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
