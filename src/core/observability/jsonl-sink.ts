import type { ArtifactStore } from "../artifact-store.js";
import type { LunaEvent, LunaObservabilitySink } from "./events.js";
import { sanitizeForObservability } from "./sanitize.js";

export async function createJsonlEventSink(
  artifactStore: ArtifactStore,
  options: { id?: string; required?: boolean } = {}
): Promise<LunaObservabilitySink> {
  await artifactStore.touchArtifact("events.jsonl");

  return {
    id: options.id ?? "jsonl",
    required: options.required ?? true,
    append: async (event: LunaEvent) => {
      await artifactStore.appendLine(
        "events.jsonl",
        sanitizeForObservability(event)
      );
    }
  };
}
