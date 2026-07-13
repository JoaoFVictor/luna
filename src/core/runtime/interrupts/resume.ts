import type { RuntimeEventStore } from "../events/contracts.js";
import {
  RuntimeDurabilityRecoveryRequiredError,
  runtimeError
} from "../errors.js";
import { stableJson } from "../json.js";
import type {
  InterruptPayload,
  InterruptRecord,
  InterruptResumeClaim,
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
    ...(payload.review === undefined ? {} : {
      review: {
        targets: payload.review.targets.map((target) => ({ ...target })),
        artifact_refs: payload.review.artifact_refs.map((reference) => ({ ...reference })),
        ...(payload.review.approval === undefined
          ? {}
          : { approval: { ...payload.review.approval } })
      }
    }),
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

function persistedResumeClaim(
  input: ResumeInput,
  interrupt: InterruptRecord
): InterruptResumeClaim | undefined {
  if (interrupt.status !== "resuming") {
    return undefined;
  }
  if (
    interrupt.resume_attempt === undefined ||
    interrupt.resume_input === undefined
  ) {
    throw runtimeError(
      "Interrupt has an incomplete durable resume claim",
      "runtime_interrupt_resume_in_progress",
      { details: { interrupt_id: input.interrupt_id } }
    );
  }
  if (!resumeInputsEqual(input, interrupt.resume_input)) {
    throw runtimeError(
      "Interrupt has already been resumed with different input",
      "interrupt_conflict",
      { details: { interrupt_id: input.interrupt_id } }
    );
  }
  return {
    interrupt_id: input.interrupt_id,
    resume_attempt: interrupt.resume_attempt,
    status: "claimed"
  };
}

async function readInterruptAfterTransitionFailure(
  options: ResumeInterruptOptions,
  interruptId: string,
  transition: "begin_resume" | "complete_resume",
  cause: unknown
): Promise<InterruptRecord | undefined> {
  try {
    return await options.interruptStore.get(interruptId);
  } catch (verificationCause) {
    throw new RuntimeDurabilityRecoveryRequiredError(
      "Interrupt resume transition may be committed, but exact readback was unavailable",
      {
        cause,
        details: {
          interrupt_id: interruptId,
          transition,
          verification_cause:
            verificationCause instanceof Error
              ? verificationCause.name
              : typeof verificationCause
        }
      }
    );
  }
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
  const concurrent = await store.findFirst(interrupt.run_id, {
    exclude_id: interrupt.id,
    thread_id: input.thread_id,
    checkpoint_id: input.checkpoint_id,
    statuses: ["pending", "resuming"]
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
  const record: InterruptRecord = {
    id: interrupt.interrupt_id,
    run_id: interrupt.run.run_id,
    thread_id: options.threadId,
    checkpoint_id: interrupt.checkpoint_id,
    node_id: interrupt.node_id,
    status: "pending",
    created_at: interrupt.created_at,
    updated_at: interrupt.created_at,
    payload: interrupt
  };

  try {
    await options.interruptStore.create(record);
  } catch (cause) {
    let accepted: InterruptRecord | undefined;
    try {
      accepted = await options.interruptStore.get(interrupt.interrupt_id);
    } catch (verificationCause) {
      throw new RuntimeDurabilityRecoveryRequiredError(
        "Interrupt creation may be committed, but exact readback was unavailable",
        {
          cause,
          details: {
            interrupt_id: interrupt.interrupt_id,
            verification_cause:
              verificationCause instanceof Error
                ? verificationCause.name
                : typeof verificationCause
          }
        }
      );
    }
    if (accepted === undefined || stableJson(accepted) !== stableJson(record)) {
      throw cause;
    }
    // Resolve an acceptance-unknown create that committed before throwing.
  }

  try {
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
  } catch {
    // The pending interrupt is authoritative and resumable. Its event
    // projection is idempotent diagnostics, never a reason to contradict it.
  }

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

  let claim = persistedResumeClaim(normalizedInput, interrupt);
  if (claim === undefined) {
    await assertNotExpired(input, interrupt, options);
    await assertNoConcurrentMerge(input, interrupt, options.interruptStore);
    await assertInterruptResumeAuthorized(
      input,
      interrupt,
      options.authorization ?? allowInterruptResume()
    );

    const requested_resume_id = options.resumeId?.() ?? defaultResumeId(input);
    let beginning;
    try {
      beginning = await options.interruptStore.beginResume(
        input.interrupt_id,
        requested_resume_id,
        normalizedInput
      );
    } catch (cause) {
      const accepted = await readInterruptAfterTransitionFailure(
        options,
        input.interrupt_id,
        "begin_resume",
        cause
      );
      if (accepted !== undefined) {
        const resolved = assertResolvedDuplicate(normalizedInput, accepted);
        if (resolved !== undefined) {
          return resolved;
        }
        const acceptedClaim = persistedResumeClaim(normalizedInput, accepted);
        if (acceptedClaim?.resume_attempt === requested_resume_id) {
          beginning = acceptedClaim;
        }
      }
      if (beginning === undefined) {
        throw cause;
      }
    }
    if (beginning.status === "duplicate") {
      return {
        ...beginning.resume,
        already_resumed: true
      };
    }
    claim = beginning;
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

  try {
    await options.interruptStore.completeResume(
      input.interrupt_id,
      claim,
      "resolved",
      resume
    );
  } catch (cause) {
    const accepted = await readInterruptAfterTransitionFailure(
      options,
      input.interrupt_id,
      "complete_resume",
      cause
    );
    if (
      accepted?.status !== "resolved" ||
      accepted.resume === undefined ||
      stableJson(accepted.resume) !== stableJson(resume)
    ) {
      throw cause;
    }
    // Resolve an acceptance-unknown transition that committed before throwing.
  }
  try {
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
  } catch {
    // Resolution is authoritative. Event projection is idempotent diagnostics.
  }

  return {
    ...resume,
    already_resumed: false
  };
}
