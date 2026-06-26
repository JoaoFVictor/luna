import type {
  InterruptRecord,
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

  return {
    async create(record) {
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
    async beginResume(id, resumeAttempt) {
      const interrupt = interrupts.get(id);
      if (interrupt === undefined) {
        throw runtimeError("Interrupt not found", "runtime_interrupt_not_found", {
          details: { interrupt_id: id }
        });
      }

      if (interrupt.status === "resuming") {
        throw runtimeError(
          "Interrupt already has a resume attempt in progress",
          "runtime_interrupt_resume_in_progress",
          { details: { interrupt_id: id } }
        );
      }

      if (interrupt.status !== "pending") {
        throw runtimeError("Interrupt cannot be resumed from its current status", "runtime_interrupt_status_invalid", {
          details: { interrupt_id: id, status: interrupt.status }
        });
      }

      interrupts.set(id, {
        ...interrupt,
        status: "resuming",
        resume_attempt: resumeAttempt,
        updated_at: new Date().toISOString()
      });

      return { interrupt_id: id, resume_attempt: resumeAttempt };
    },
    async completeResume(id, status) {
      const interrupt = interrupts.get(id);
      if (interrupt === undefined) {
        throw runtimeError("Interrupt not found", "runtime_interrupt_not_found", {
          details: { interrupt_id: id }
        });
      }

      if (interrupt.status !== "resuming") {
        throw runtimeError("Interrupt resume is not in progress", "runtime_interrupt_status_invalid", {
          details: { interrupt_id: id, status: interrupt.status }
        });
      }

      interrupts.set(id, {
        ...interrupt,
        status,
        updated_at: new Date().toISOString()
      });
    }
  };
}
