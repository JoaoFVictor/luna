import { readFile } from "node:fs/promises";
import { appendOnlyJsonlWriter } from "../../../core/artifacts/append-only-jsonl-writer.js";
import type { BackendRegistration } from "../../../core/runtime/backends/contracts.js";
import type {
  RuntimeEvent,
  RuntimeEventStore
} from "../../../core/runtime/events/contracts.js";
import { safeJoin } from "../../../core/security/path.js";
import { z } from "zod";

export const FilesystemEventBackendOptionsSchema = z
  .object({ root: z.string().min(1) })
  .strict();
export const filesystemEventBackendRegistration = {
  id: "filesystem.events",
  kind: "event",
  optionsSchema: FilesystemEventBackendOptionsSchema
} satisfies BackendRegistration<z.infer<typeof FilesystemEventBackendOptionsSchema>>;

export type FilesystemEventStoreOptions = {
  root: string;
};

const RuntimeEventSchema = z
  .object({
    id: z.string().min(1),
    run_id: z.string().min(1),
    sequence: z.number().int().positive(),
    type: z.string().min(1),
    timestamp: z.string().min(1),
    node_id: z.string().min(1).optional(),
    interrupt_id: z.string().min(1).optional(),
    resume_id: z.string().min(1).optional(),
    data: z.record(z.unknown()).optional()
  })
  .strict();
const appendTails = new Map<string, Promise<unknown>>();

async function withFileTail<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = appendTails.get(filePath) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  appendTails.set(filePath, next.catch(() => undefined));

  return await next;
}

export function createFilesystemEventStore({
  root
}: FilesystemEventStoreOptions): RuntimeEventStore {
  async function filePath(runId: string): Promise<string> {
    return await safeJoin(root, [runId, "events.jsonl"]);
  }

  return {
    async append(input) {
      const targetPath = await filePath(input.run_id);

      return await withFileTail(targetPath, async () => {
        const events = await this.list(input.run_id);
        const event = {
          ...input,
          sequence: input.sequence ?? events.length + 1
        };

        await appendOnlyJsonlWriter({
          filePath: targetPath,
          value: event
        });

        return event;
      });
    },
    async list(runId) {
      try {
        const content = await readFile(await filePath(runId), "utf8");
        return content
          .trim()
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => RuntimeEventSchema.parse(JSON.parse(line)) as RuntimeEvent);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }

        throw cause;
      }
    },
    async query(query) {
      const events = await this.list(query.runId);

      return events
        .filter((event) => query.nodeId === undefined || event.node_id === query.nodeId)
        .filter((event) => query.interruptId === undefined || event.interrupt_id === query.interruptId)
        .filter((event) => query.resumeId === undefined || event.resume_id === query.resumeId);
    }
  };
}
