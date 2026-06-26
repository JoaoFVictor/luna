import type {
  BackendRegistration,
  RuntimeLogEntry,
  RuntimeLogStore
} from "../../../core/runtime/backends/contracts.js";
import { z } from "zod";

export const MemoryRuntimeLogBackendOptionsSchema = z.object({}).strict();
export const memoryRuntimeLogBackendRegistration = {
  id: "memory.runtime-log",
  kind: "runtime_log",
  optionsSchema: MemoryRuntimeLogBackendOptionsSchema
} satisfies BackendRegistration<z.infer<typeof MemoryRuntimeLogBackendOptionsSchema>>;

export function createMemoryRuntimeLogStore(): RuntimeLogStore {
  const entriesByRun = new Map<string, RuntimeLogEntry[]>();

  return {
    async append(input) {
      const entries = entriesByRun.get(input.run_id) ?? [];
      const entry = {
        ...input,
        sequence: input.sequence ?? entries.length + 1
      };

      entries.push(entry);
      entriesByRun.set(input.run_id, entries);

      return { ...entry };
    },
    async list(runId) {
      return (entriesByRun.get(runId) ?? []).map((entry) => ({ ...entry }));
    }
  };
}
