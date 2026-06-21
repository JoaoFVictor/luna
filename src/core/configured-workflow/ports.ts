import type { SchedulerLockManager } from "../workflow-scheduler.js";
import type { ObservabilityPort, RunLockPort } from "./contracts.js";
import type { LunaObservability } from "../observability/luna-observability.js";

export function createRunLockPort(
  lockManager: SchedulerLockManager & { heartbeat?: () => Promise<void> }
): RunLockPort {
  return {
    async acquire({ runtimeRunId, resource }) {
      const release = await lockManager.acquire(resource, "exclusive");

      return {
        runtimeRunId,
        release
      };
    },
    async heartbeat({ runtimeRunId }) {
      await lockManager.heartbeat?.();
      return runtimeRunId;
    }
  };
}

export function schedulerLockManagerFromPort({
  port,
  runtimeRunId
}: {
  port: RunLockPort;
  runtimeRunId: string;
}): SchedulerLockManager {
  return {
    async acquire(resource) {
      const lock = await port.acquire({ runtimeRunId, resource });
      return lock.release;
    }
  };
}

export function createObservabilityPort(
  observability: LunaObservability
): ObservabilityPort {
  return {
    async emit({ event }) {
      await observability.emit(event);
    }
  };
}
