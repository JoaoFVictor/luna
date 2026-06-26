import type {
  InterruptRecord,
  ResumeInput,
  InterruptStore
} from "../../../core/runtime/interrupts/contracts.js";
import type { BackendRegistration } from "../../../core/runtime/backends/contracts.js";
import { runtimeError } from "../../../core/runtime/errors.js";
import { z } from "zod";

export const MemoryInterruptBackendOptionsSchema = z.object({}).strict();
export const memoryInterruptBackendRegistration = {
  id: "memory.interrupts",
  kind: "interrupt",
  optionsSchema: MemoryInterruptBackendOptionsSchema
} satisfies BackendRegistration<z.infer<typeof MemoryInterruptBackendOptionsSchema>>;

export function createMemoryInterruptStore(): InterruptStore {
  const interrupts = new Map<string, InterruptRecord>();
  const pendingResumes = new Map<string, PendingResume>();

  return {
    async create(record) {
      pendingResumes.delete(record.id);
      interrupts.set(record.id, { ...record });
    },
    async get(id) {
      const interrupt = interrupts.get(id);

      return interrupt === undefined ? undefined : { ...interrupt };
    },
    async list(runId) {
      return [...interrupts.values()]
        .filter((interrupt) => interrupt.run_id === runId)
        .map((interrupt) => ({ ...interrupt }));
    },
    async beginResume(id, resumeAttempt, input) {
      const interrupt = interrupts.get(id);
      if (interrupt === undefined) {
        throw runtimeError("Interrupt not found", "runtime_interrupt_not_found", {
          details: { interrupt_id: id }
        });
      }

      if (interrupt.status === "resuming") {
        if (interrupt.resume_attempt === undefined) {
          throw runtimeError(
            "Interrupt already has a resume attempt in progress",
            "runtime_interrupt_resume_in_progress",
            { details: { interrupt_id: id } }
          );
        }

        const pending = pendingResumes.get(id);
        if (pending === undefined) {
          throw runtimeError(
            "Interrupt already has a resume attempt in progress",
            "runtime_interrupt_resume_in_progress",
            { details: { interrupt_id: id } }
          );
        }
        if (!resumeInputsEqual(input, pending.input)) {
          throw runtimeError(
            "Interrupt has already been resumed with different input",
            "interrupt_conflict",
            { details: { interrupt_id: id } }
          );
        }

        return await pending.result.then((resume) => {
          return {
            interrupt_id: id,
            resume_attempt: resume.resume_id,
            status: "duplicate" as const,
            resume: structuredClone(resume)
          };
        });
      }

      if (interrupt.status === "resolved" && interrupt.resume !== undefined) {
        if (!resumeInputsEqual(input, interrupt.resume.input)) {
          throw runtimeError(
            "Interrupt has already been resumed with different input",
            "interrupt_conflict",
            { details: { interrupt_id: id } }
          );
        }

        return {
          interrupt_id: id,
          resume_attempt: interrupt.resume.resume_id,
          status: "duplicate",
          resume: structuredClone(interrupt.resume)
        };
      }

      if (interrupt.status !== "pending") {
        throw runtimeError("Interrupt cannot be resumed from its current status", "runtime_interrupt_status_invalid", {
          details: { interrupt_id: id, status: interrupt.status }
        });
      }

      const pending = createPendingResume(input);
      pendingResumes.set(id, pending);
      interrupts.set(id, {
        ...interrupt,
        status: "resuming",
        resume_attempt: resumeAttempt,
        updated_at: new Date().toISOString()
      });

      return { interrupt_id: id, resume_attempt: resumeAttempt, status: "claimed" };
    },
    async completeResume(id, claim, status, resume) {
      const interrupt = interrupts.get(id);
      if (interrupt === undefined) {
        throw runtimeError("Interrupt not found", "runtime_interrupt_not_found", {
          details: { interrupt_id: id }
        });
      }

      if (
        interrupt.status !== "resuming" ||
        interrupt.resume_attempt !== claim.resume_attempt
      ) {
        throw runtimeError("Interrupt resume is not in progress", "runtime_interrupt_status_invalid", {
          details: {
            interrupt_id: id,
            status: interrupt.status,
            resume_attempt: interrupt.resume_attempt,
            claim_resume_attempt: claim.resume_attempt
          }
        });
      }

      const next = {
        ...interrupt,
        status,
        ...(resume === undefined ? {} : { resume }),
        updated_at: new Date().toISOString()
      };
      interrupts.set(id, next);
      const pending = pendingResumes.get(id);
      pendingResumes.delete(id);
      if (resume !== undefined) {
        pending?.resolve(structuredClone(resume));
      } else {
        pending?.reject(
          runtimeError(
            "Interrupt resume completed without a resumable decision",
            "runtime_interrupt_status_invalid",
            { details: { interrupt_id: id, status } }
          )
        );
      }
    }
  };
}

type PendingResume = {
  readonly input: ResumeInput;
  readonly result: Promise<NonNullable<InterruptRecord["resume"]>>;
  readonly resolve: (resume: NonNullable<InterruptRecord["resume"]>) => void;
  readonly reject: (cause: Error) => void;
};

function createPendingResume(input: ResumeInput): PendingResume {
  let resolve!: (resume: NonNullable<InterruptRecord["resume"]>) => void;
  let reject!: (cause: Error) => void;
  const result = new Promise<NonNullable<InterruptRecord["resume"]>>((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return { input, result, resolve, reject };
}

function resumeInputsEqual(left: ResumeInput, right: ResumeInput): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right)
  );

  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}
