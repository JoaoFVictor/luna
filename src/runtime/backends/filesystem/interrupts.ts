import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { BackendRegistration } from "../../../core/runtime/backends/contracts.js";
import type {
  InterruptRecord,
  InterruptStore
} from "../../../core/runtime/interrupts/contracts.js";
import { resumeInputsEqual } from "../../../core/runtime/interrupts/resume.js";
import { runtimeError } from "../../../core/runtime/errors.js";
import { safeJoin } from "../../../core/security/path.js";
import { atomicWriteFile } from "../../../core/artifacts/atomic-write.js";

export const FilesystemInterruptBackendOptionsSchema = z
  .object({ root: z.string().min(1) })
  .strict();

export const filesystemInterruptBackendRegistration = {
  id: "filesystem.interrupts",
  kind: "interrupt",
  optionsSchema: FilesystemInterruptBackendOptionsSchema
} satisfies BackendRegistration<z.infer<typeof FilesystemInterruptBackendOptionsSchema>>;

export type FilesystemInterruptStoreOptions = {
  root: string;
};

const writeTails = new Map<string, Promise<unknown>>();

export function createFilesystemInterruptStore({
  root
}: FilesystemInterruptStoreOptions): InterruptStore {
  async function filePath(id: string): Promise<string> {
    return await safeJoin(root, [`${encodeURIComponent(id)}.json`]);
  }

  async function readRecord(id: string): Promise<InterruptRecord | undefined> {
    try {
      return JSON.parse(await readFile(await filePath(id), "utf8")) as InterruptRecord;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw cause;
    }
  }

  async function writeRecord(record: InterruptRecord): Promise<void> {
    await mkdir(root, { recursive: true });
    await atomicWriteFile(
      await filePath(record.id),
      `${JSON.stringify(record, null, 2)}\n`,
      0o600
    );
  }

  async function withRecordTail<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = writeTails.get(id) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    writeTails.set(id, next.catch(() => undefined));

    return await next;
  }

  return {
    async create(record) {
      await withRecordTail(record.id, async () => {
        await writeRecord({ ...record });
      });
    },
    async get(id) {
      const record = await readRecord(id);

      return record === undefined ? undefined : structuredClone(record);
    },
    async list(runId) {
      try {
        const entries = await readdir(root);
        const records = await Promise.all(
          entries
            .filter((entry) => entry.endsWith(".json"))
            .map(async (entry) =>
              JSON.parse(await readFile(path.join(root, entry), "utf8")) as InterruptRecord
            )
        );

        return records
          .filter((record) => record.run_id === runId)
          .map((record) => structuredClone(record));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw cause;
      }
    },
    async beginResume(id, resumeAttempt, input) {
      return await withRecordTail(id, async () => {
        const interrupt = await readRequiredRecord(id);

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
            status: "duplicate" as const,
            resume: structuredClone(interrupt.resume)
          };
        }

        if (interrupt.status === "resuming") {
          if (
            interrupt.resume_attempt === undefined ||
            interrupt.resume_input === undefined
          ) {
            throw runtimeError(
              "Interrupt already has a resume attempt in progress",
              "runtime_interrupt_resume_in_progress",
              { details: { interrupt_id: id } }
            );
          }
          if (!resumeInputsEqual(input, interrupt.resume_input)) {
            throw runtimeError(
              "Interrupt has already been resumed with different input",
              "interrupt_conflict",
              { details: { interrupt_id: id } }
            );
          }

          return {
            interrupt_id: id,
            resume_attempt: interrupt.resume_attempt,
            status: "claimed" as const
          };
        }

        if (interrupt.status !== "pending") {
          throw runtimeError(
            "Interrupt cannot be resumed from its current status",
            "runtime_interrupt_status_invalid",
            { details: { interrupt_id: id, status: interrupt.status } }
          );
        }

        await writeRecord({
          ...interrupt,
          status: "resuming",
          resume_attempt: resumeAttempt,
          resume_input: structuredClone(input),
          updated_at: new Date().toISOString()
        });

        return { interrupt_id: id, resume_attempt: resumeAttempt, status: "claimed" as const };
      });
    },
    async completeResume(id, claim, status, resume) {
      await withRecordTail(id, async () => {
        const interrupt = await readRequiredRecord(id);

        if (
          interrupt.status !== "resuming" ||
          interrupt.resume_attempt !== claim.resume_attempt
        ) {
          throw runtimeError(
            "Interrupt resume is not in progress",
            "runtime_interrupt_status_invalid",
            {
              details: {
                interrupt_id: id,
                status: interrupt.status,
                resume_attempt: interrupt.resume_attempt,
                claim_resume_attempt: claim.resume_attempt
              }
            }
          );
        }

        await writeRecord({
          ...interrupt,
          status,
          resume_input: undefined,
          ...(resume === undefined ? {} : { resume }),
          updated_at: new Date().toISOString()
        });
      });
    }
  };

  async function readRequiredRecord(id: string): Promise<InterruptRecord> {
    const interrupt = await readRecord(id);
    if (interrupt === undefined) {
      throw runtimeError("Interrupt not found", "runtime_interrupt_not_found", {
        details: { interrupt_id: id }
      });
    }

    return interrupt;
  }
}
