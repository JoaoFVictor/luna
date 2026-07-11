import type {
  StudioAgentTestPlanRequest,
  StudioAgentTestResolution
} from "../../contracts/agent-test-bench.js";
import { studioAgentTestValueDigest } from "./test-bench-digests.js";

export function freezeStudioAgentTestValue<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const visited = new Set<object>();
  const pending: object[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const nested of Object.values(current)) {
      if (typeof nested === "object" && nested !== null) {
        pending.push(nested);
      }
    }
    Object.freeze(current);
  }
  return value;
}

export function studioAgentTestSnapshotHash(
  request: StudioAgentTestPlanRequest,
  resolution: StudioAgentTestResolution
): string {
  return studioAgentTestValueDigest({
    schema_version: 1,
    request,
    resolution
  });
}
