import { stableJson } from "../../../core/runtime/json.js";
import type {
  InterruptRecord,
  InterruptResumeRecord,
  InterruptStore,
  ResumeInput
} from "../../../core/runtime/interrupts/contracts.js";
import {
  normalizeResumeInput,
  resumeInputsEqual
} from "../../../core/runtime/interrupts/resume.js";
import { runStoreError } from "../../application/runs/errors.js";
import type { NativeStudioQueuedResume } from "../filesystem/run-resume-contracts.js";

export function assertNativeStudioResolvedResumeMatchesJob(
  job: NativeStudioQueuedResume,
  resume: InterruptResumeRecord
): void {
  const expectedInput = normalizeResumeInput({
    interrupt_id: job.interrupt_id,
    thread_id: job.thread_id,
    checkpoint_id: job.checkpoint_id,
    decision: job.decision
  });
  if (
    resume.resume_id !== job.resume_id ||
    !resumeInputsEqual(resume.input, expectedInput) ||
    stableJson(resume.decision) !== stableJson(job.decision)
  ) {
    throw runStoreError(
      "run_store_corrupt",
      "A durable resume decision conflicts with the queued resume command"
    );
  }
}

function exactClaimAlreadyExists(
  job: NativeStudioQueuedResume,
  current: InterruptRecord,
  resumeInput: ResumeInput
): boolean {
  if (current.status === "resolved") {
    if (
      current.resume_attempt !== job.resume_id ||
      current.resume === undefined
    ) {
      throw runStoreError(
        "run_store_corrupt",
        "The resolved interrupt does not match the queued resume command"
      );
    }
    assertNativeStudioResolvedResumeMatchesJob(job, current.resume);
    return true;
  }
  if (current.status !== "resuming") return false;
  if (
    current.resume_attempt !== job.resume_id ||
    current.resume_input === undefined ||
    !resumeInputsEqual(current.resume_input, resumeInput)
  ) {
    throw runStoreError(
      "run_idempotency_conflict",
      "The interrupt is resuming with a different decision"
    );
  }
  return true;
}

/** Establishes or verifies the exact durable claim for one immutable job. */
export async function ensureNativeStudioResumeInterruptClaim(
  interrupts: Pick<InterruptStore, "get" | "beginResume">,
  job: NativeStudioQueuedResume
): Promise<void> {
  const resumeInput: ResumeInput = normalizeResumeInput({
    interrupt_id: job.interrupt_id,
    thread_id: job.thread_id,
    checkpoint_id: job.checkpoint_id,
    decision: job.decision
  });
  const current = await interrupts.get(job.interrupt_id);
  if (current === undefined) {
    throw runStoreError("run_not_found", "The requested interrupt does not exist");
  }
  if (exactClaimAlreadyExists(job, current, resumeInput)) return;
  if (current.status !== "pending") {
    throw runStoreError(
      "run_transition_invalid",
      "The interrupt cannot accept a resume claim"
    );
  }
  try {
    await interrupts.beginResume(job.interrupt_id, job.resume_id, resumeInput);
  } catch (cause) {
    const accepted = await interrupts.get(job.interrupt_id);
    if (
      accepted !== undefined &&
      exactClaimAlreadyExists(job, accepted, resumeInput)
    ) {
      return;
    }
    throw cause;
  }
}
