import type {
  InterruptRecord,
  ResumeInput,
  PagedInterruptStore
} from "../../../core/runtime/interrupts/contracts.js";
import { resumeInputsEqual } from "../../../core/runtime/interrupts/resume.js";
import type { BackendRegistration } from "../../../core/runtime/backends/contracts.js";
import { runtimeError } from "../../../core/runtime/errors.js";
import { stableJson } from "../../../core/runtime/json.js";
import { z } from "zod";
import {
  compareInterruptRecordsNewestFirst,
  decodeInterruptPageCursor,
  encodeInterruptPageCursor,
  interruptPageStartIndex
} from "../../../core/runtime/interrupts/page-cursor.js";

export const MemoryInterruptBackendOptionsSchema = z.object({}).strict();
export const memoryInterruptBackendRegistration = {
  id: "memory.interrupts",
  kind: "interrupt",
  optionsSchema: MemoryInterruptBackendOptionsSchema
} satisfies BackendRegistration<z.infer<typeof MemoryInterruptBackendOptionsSchema>>;

export function createMemoryInterruptStore(): PagedInterruptStore {
  const interrupts = new Map<string, InterruptRecord>();
  const pendingResumes = new Map<string, PendingResume>();
  const resumeLeaseTails = new Map<string, Promise<void>>();

  return {
    async create(record) {
      const existing = interrupts.get(record.id);
      if (existing !== undefined) {
        if (stableJson(existing) === stableJson(record)) {
          return;
        }
        throw runtimeError(
          "Interrupt identity already belongs to different durable state",
          "interrupt_conflict",
          { details: { interrupt_id: record.id } }
        );
      }
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
    async findFirst(runId, query) {
      const nodeIds = query.node_ids === undefined
        ? undefined
        : new Set(query.node_ids);
      const statuses = query.statuses === undefined
        ? undefined
        : new Set(query.statuses);
      const match = [...interrupts.values()]
        .filter((interrupt) => interrupt.run_id === runId)
        .sort(compareInterruptRecordsNewestFirst)
        .find((interrupt) =>
          interrupt.id !== query.exclude_id &&
          (query.thread_id === undefined || interrupt.thread_id === query.thread_id) &&
          (query.checkpoint_id === undefined || interrupt.checkpoint_id === query.checkpoint_id) &&
          (nodeIds === undefined || nodeIds.has(interrupt.node_id ?? "")) &&
          (query.created_after === undefined || interrupt.created_at > query.created_after) &&
          (statuses === undefined || statuses.has(interrupt.status))
        );
      return match === undefined ? undefined : structuredClone(match);
    },
    async listPage(runId, query) {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200) {
        throw runtimeError("Interrupt page limit is invalid", "runtime_state_invalid");
      }
      const records = [...interrupts.values()]
        .filter((interrupt) => interrupt.run_id === runId)
        .sort(compareInterruptRecordsNewestFirst);
      const cursor = query.cursor === undefined
        ? undefined
        : decodeInterruptPageCursor(runId, query.cursor);
      const start = interruptPageStartIndex(records, cursor);
      const page = records.slice(start, start + query.limit);
      const hasMore = start + page.length < records.length;
      return {
        records: page.map((record) => structuredClone(record)),
        next_cursor: hasMore && page.length > 0
          ? encodeInterruptPageCursor(runId, page.at(-1)!)
          : null
      };
    },
    async withResumeLease(id, operation) {
      const previous = resumeLeaseTails.get(id) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current, () => current);
      resumeLeaseTails.set(id, tail);
      await previous.catch(() => undefined);
      try {
        return await operation();
      } finally {
        release();
        if (resumeLeaseTails.get(id) === tail) {
          resumeLeaseTails.delete(id);
        }
      }
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
        resume_input: structuredClone(input),
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
        resume_input: undefined,
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
