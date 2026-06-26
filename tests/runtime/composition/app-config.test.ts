import { describe, expect, it } from "vitest";
import {
  RuntimeCompositionConfigSchema,
  parseRuntimeCompositionConfig
} from "../../../src/runtime/composition/app-config.js";

describe("runtime composition app config", () => {
  it("parses backend ids, agent runtime id, interrupt auth, and capability ports", () => {
    const config = parseRuntimeCompositionConfig({
      mode: "production",
      backends: {
        artifacts: {
          id: "filesystem.artifacts",
          options: { root: ".runs/artifacts" }
        },
        events: {
          id: "filesystem.events",
          options: { root: ".runs/events" }
        },
        interrupts: {
          id: "memory.interrupts",
          options: {}
        },
        checkpoints: {
          id: "sqlite.checkpoints",
          options: { filePath: ".runs/checkpoints/luna.sqlite" }
        },
        runtime_logs: {
          id: "filesystem.runtime-log",
          options: { root: ".runs/logs" }
        }
      },
      agent_runtime: { id: "flue", options: {} },
      interrupt_authorization: { id: "allow_all", options: {} },
      capability_ports: {
        artifacts: {
          id: "artifacts.manifest_store",
          options: { backend: "filesystem.artifacts" }
        }
      }
    });

    expect(config.backends.checkpoints.id).toBe("sqlite.checkpoints");
    expect(config.agent_runtime.id).toBe("flue");
    expect(config.interrupt_authorization?.id).toBe("allow_all");
    expect(config.capability_ports?.artifacts?.id).toBe(
      "artifacts.manifest_store"
    );
  });

  it("keeps LangSmith and LangGraph Platform out of required configuration", () => {
    const result = RuntimeCompositionConfigSchema.safeParse({
      mode: "test",
      backends: {
        artifacts: { id: "memory.artifacts", options: {} },
        events: { id: "memory.events", options: {} },
        interrupts: { id: "memory.interrupts", options: {} },
        checkpoints: { id: "memory.checkpoints", options: {} },
        runtime_logs: { id: "memory.runtime-log", options: {} }
      },
      agent_runtime: { id: "flue", options: {} },
      interrupt_authorization: { id: "allow_all", options: {} },
      langsmith: { project: "not-required" },
      langgraph_platform: { deployment: "not-required" }
    });

    expect(result.success).toBe(false);
  });
});
