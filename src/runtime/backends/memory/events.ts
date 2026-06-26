import type {
  RuntimeEvent,
  RuntimeEventStore
} from "../../../core/runtime/events/contracts.js";
import type { BackendRegistration } from "../../../core/runtime/backends/contracts.js";
import { z } from "zod";

export const MemoryEventBackendOptionsSchema = z.object({}).strict();
export const memoryEventBackendRegistration = {
  id: "memory.events",
  kind: "event",
  optionsSchema: MemoryEventBackendOptionsSchema
} satisfies BackendRegistration<z.infer<typeof MemoryEventBackendOptionsSchema>>;

export function createMemoryEventStore(): RuntimeEventStore {
  const eventsByRun = new Map<string, RuntimeEvent[]>();

  return {
    async append(input) {
      const events = eventsByRun.get(input.run_id) ?? [];
      const event = {
        ...input,
        sequence: input.sequence ?? events.length + 1
      };

      events.push(event);
      eventsByRun.set(input.run_id, events);

      return { ...event };
    },
    async list(runId) {
      return (eventsByRun.get(runId) ?? []).map((event) => ({ ...event }));
    },
    async query(query) {
      const events = eventsByRun.get(query.runId) ?? [];

      return events
        .filter((event) => query.nodeId === undefined || event.node_id === query.nodeId)
        .filter((event) => query.interruptId === undefined || event.interrupt_id === query.interruptId)
        .filter((event) => query.resumeId === undefined || event.resume_id === query.resumeId)
        .map((event) => ({ ...event }));
    }
  };
}
