import { readFile } from "node:fs/promises";
import { appendOnlyJsonlWriter } from "../../../core/artifacts/append-only-jsonl-writer.js";
import type {
  BackendRegistration,
  RuntimeLogEntry,
  RuntimeLogStore
} from "../../../core/runtime/backends/contracts.js";
import { safeJoin } from "../../../core/security/path.js";
import { z } from "zod";

export const FilesystemRuntimeLogBackendOptionsSchema = z
  .object({ root: z.string().min(1) })
  .strict();
export const filesystemRuntimeLogBackendRegistration = {
  id: "filesystem.runtime-log",
  kind: "runtime_log",
  optionsSchema: FilesystemRuntimeLogBackendOptionsSchema
} satisfies BackendRegistration<z.infer<typeof FilesystemRuntimeLogBackendOptionsSchema>>;

export type FilesystemRuntimeLogStoreOptions = {
  root: string;
};

const RuntimeLogEntrySchema = z
  .object({
    run_id: z.string().min(1),
    sequence: z.number().int().positive(),
    timestamp: z.string().min(1),
    message: z.string(),
    level: z.enum(["debug", "info", "warn", "error"]).optional(),
    node_id: z.string().min(1).optional()
  })
  .strict();
const appendTails = new Map<string, Promise<unknown>>();

async function withFileTail<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = appendTails.get(filePath) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  appendTails.set(filePath, next.catch(() => undefined));

  return await next;
}

export function createFilesystemRuntimeLogStore({
  root
}: FilesystemRuntimeLogStoreOptions): RuntimeLogStore {
  async function filePath(runId: string): Promise<string> {
    return await safeJoin(root, [runId, "runtime.log.jsonl"]);
  }

  return {
    async append(input) {
      const targetPath = await filePath(input.run_id);

      return await withFileTail(targetPath, async () => {
        const entries = await this.list(input.run_id);
        const entry = {
          ...input,
          sequence: input.sequence ?? entries.length + 1
        };

        await appendOnlyJsonlWriter({
          filePath: targetPath,
          value: entry
        });

        return entry;
      });
    },
    async list(runId) {
      try {
        const content = await readFile(await filePath(runId), "utf8");
        return content
          .trim()
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => RuntimeLogEntrySchema.parse(JSON.parse(line)) as RuntimeLogEntry);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }

        throw cause;
      }
    }
  };
}
