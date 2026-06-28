import type { RuntimeEventStore } from "../events/contracts.js";
import { runtimeError } from "../errors.js";
import { stableJson } from "../json.js";
import type {
  InterruptPayload,
  InterruptRecord,
  InterruptResumeRecord,
  InterruptResumeResult,
  InterruptStore,
  ResumeInput
} from "./contracts.js";
import {
  allowInterruptResume,
  assertInterruptResumeAuthorized,
  type InterruptResumeAuthorizationPort
} from "./authorization.js";

export type CreateInterruptOptions = {
  threadId: string;
  interruptStore: InterruptStore;
  eventStore: RuntimeEventStore;
};

export type InterruptExpirationPolicy = {
  allowExpiredResume(input: ResumeInput, interrupt: InterruptRecord): boolean | Promise<boolean>;
};

export type ResumeInterruptOptions = {
  interruptStore: InterruptStore;
  eventStore: RuntimeEventStore;
  authorization?: InterruptResumeAuthorizationPort;
  expirationPolicy?: InterruptExpirationPolicy;
  now?: () => string;
  resumeId?: () => string;
};

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultResumeId(input: ResumeInput): string {
  return `${input.interrupt_id}:resume:${Date.now()}`;
}

function clonePayload(payload: InterruptPayload): InterruptPayload {
  return {
    interrupt_id: payload.interrupt_id,
    run: { ...payload.run },
    checkpoint_id: payload.checkpoint_id,
    node_id: payload.node_id,
    kind: payload.kind,
    prompt: payload.prompt,
    decisions: [...payload.decisions],
    created_at: payload.created_at,
    ...(payload.expires_at === undefined ? {} : { expires_at: payload.expires_at })
  };
}

export function normalizeResumeInput(input: ResumeInput): ResumeInput {
  return {
    interrupt_id: input.interrupt_id,
    thread_id: input.thread_id,
    checkpoint_id: input.checkpoint_id,
    decision: input.decision,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
    ...(input.actor === undefined ? {} : { actor: input.actor })
  };
}

export function resumeInputsEqual(left: ResumeInput, right: ResumeInput): boolean {
  return stableJson(normalizeResumeInput(left)) === stableJson(normalizeResumeInput(right));
}

function assertOriginMatches(input: ResumeInput, interrupt: InterruptRecord): void {
  if (interrupt.thread_id !== input.thread_id || interrupt.checkpoint_id !== input.checkpoint_id) {
    throw runtimeError("Interrupt resume does not match the originating thread or checkpoint", "interrupt_stale", {
      details: {
        interrupt_id: input.interrupt_id,
        expected_thread_id: interrupt.thread_id,
        actual_thread_id: input.thread_id,
        expected_checkpoint_id: interrupt.checkpoint_id,
        actual_checkpoint_id: input.checkpoint_id
      }
    });
  }
}

function assertResolvedDuplicate(input: ResumeInput, interrupt: InterruptRecord): InterruptResumeResult | undefined {
  if (interrupt.status !== "resolved" || interrupt.resume === undefined) {
    return undefined;
  }

  if (!resumeInputsEqual(input, interrupt.resume.input)) {
    throw runtimeError("Interrupt has already been resumed with different input", "interrupt_conflict", {
      details: { interrupt_id: input.interrupt_id }
    });
  }

  return {
    ...interrupt.resume,
    already_resumed: true
  };
}

async function assertNotExpired(
  input: ResumeInput,
  interrupt: InterruptRecord,
  options: ResumeInterruptOptions
): Promise<void> {
  const expiresAt = interrupt.payload?.expires_at;
  if (expiresAt === undefined) {
    return;
  }

  const now = options.now?.() ?? defaultNow();
  if (Date.parse(expiresAt) >= Date.parse(now)) {
    return;
  }

  if (await options.expirationPolicy?.allowExpiredResume(input, interrupt)) {
    return;
  }

  throw runtimeError("Interrupt has expired", "interrupt_expired", {
    details: {
      interrupt_id: input.interrupt_id,
      expires_at: expiresAt,
      now
    }
  });
}

async function assertNoConcurrentMerge(input: ResumeInput, interrupt: InterruptRecord, store: InterruptStore): Promise<void> {
  const interrupts = await store.list(interrupt.run_id);
  const concurrent = interrupts.find((candidate) => {
    if (candidate.id === interrupt.id) {
      return false;
    }

    return (
      candidate.thread_id === input.thread_id &&
      candidate.checkpoint_id === input.checkpoint_id &&
      (candidate.status === "pending" || candidate.status === "resuming")
    );
  });

  if (concurrent !== undefined) {
    throw runtimeError(
      "Concurrent interrupt merge is not supported",
      "interrupt_concurrent_merge_unsupported",
      {
        details: {
          interrupt_id: input.interrupt_id,
          concurrent_interrupt_id: concurrent.id,
          thread_id: input.thread_id,
          checkpoint_id: input.checkpoint_id
        }
      }
    );
  }
}

export async function createInterrupt(
  payload: InterruptPayload,
  options: CreateInterruptOptions
): Promise<InterruptPayload> {
  const interrupt = clonePayload(payload);

  await options.interruptStore.create({
    id: interrupt.interrupt_id,
    run_id: interrupt.run.run_id,
    thread_id: options.threadId,
    checkpoint_id: interrupt.checkpoint_id,
    node_id: interrupt.node_id,
    status: "pending",
    created_at: interrupt.created_at,
    updated_at: interrupt.created_at,
    payload: interrupt
  });

  await options.eventStore.append({
    id: `${interrupt.interrupt_id}:created`,
    run_id: interrupt.run.run_id,
    type: "luna.interrupt.created",
    timestamp: interrupt.created_at,
    node_id: interrupt.node_id,
    interrupt_id: interrupt.interrupt_id,
    data: {
      checkpoint_id: interrupt.checkpoint_id,
      kind: interrupt.kind
    }
  });

  return interrupt;
}

export async function resumeInterrupt(
  input: ResumeInput,
  options: ResumeInterruptOptions
): Promise<InterruptResumeResult> {
  const interrupt = await options.interruptStore.get(input.interrupt_id);
  if (interrupt === undefined) {
    throw runtimeError("Interrupt not found", "runtime_interrupt_not_found", {
      details: { interrupt_id: input.interrupt_id }
    });
  }

  assertOriginMatches(input, interrupt);

  const normalizedInput = normalizeResumeInput(input);
  const duplicate = assertResolvedDuplicate(normalizedInput, interrupt);
  if (duplicate !== undefined) {
    return duplicate;
  }

  await assertNotExpired(input, interrupt, options);
  await assertNoConcurrentMerge(input, interrupt, options.interruptStore);
  await assertInterruptResumeAuthorized(
    input,
    interrupt,
    options.authorization ?? allowInterruptResume()
  );

  const requested_resume_id = options.resumeId?.() ?? defaultResumeId(input);
  const claim = await options.interruptStore.beginResume(
    input.interrupt_id,
    requested_resume_id,
    normalizedInput
  );
  if (claim.status === "duplicate") {
    return {
      ...claim.resume,
      already_resumed: true
    };
  }

  const created_at = options.now?.() ?? defaultNow();
  const resume_id = claim.resume_attempt;
  const resume: InterruptResumeRecord = {
    interrupt_id: input.interrupt_id,
    resume_id,
    input: normalizedInput,
    decision: input.decision,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    created_at
  };

  await options.interruptStore.completeResume(
    input.interrupt_id,
    claim,
    "resolved",
    resume
  );
  await options.eventStore.append({
    id: `${input.interrupt_id}:${resume_id}:resumed`,
    run_id: interrupt.run_id,
    type: "luna.interrupt.resumed",
    timestamp: created_at,
    node_id: interrupt.node_id,
    interrupt_id: input.interrupt_id,
    resume_id,
    data: {
      checkpoint_id: input.checkpoint_id,
      decision: input.decision,
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      ...(input.actor === undefined ? {} : { actor: input.actor })
    }
  });

  return {
    ...resume,
    already_resumed: false
  };
}
