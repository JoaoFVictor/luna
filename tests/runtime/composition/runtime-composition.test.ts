import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { RuntimeEventStore } from "../../../src/core/runtime/events/contracts.js";
import { manifest as artifactsManifest } from "../../../src/capabilities/artifacts/manifest.js";
import { piAgentRuntimeFactory } from "../../../src/agent-runtimes/pi/factory.js";
import {
  createRuntimeComposition,
  defaultRuntimeBackendFactoryCatalog
} from "../../../src/runtime/composition/runtime-composition.js";

describe("runtime composition", () => {
  const piRuntimeFactories = {
    [piAgentRuntimeFactory.id]: piAgentRuntimeFactory
  };

  it("materializes configured runtime dependencies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-composition-"));
    const checkpointFile = path.join(root, "checkpoints.sqlite");

    try {
      const composition = createRuntimeComposition({
        mode: "production",
        backends: {
          artifacts: { id: "memory.artifacts", options: {} },
          events: { id: "memory.events", options: {} },
          interrupts: { id: "memory.interrupts", options: {} },
          checkpoints: {
            id: "sqlite.checkpoints",
            options: { filePath: checkpointFile }
          },
          runtime_logs: { id: "memory.runtime-log", options: {} }
        },
        agent_runtime: { id: "pi", options: {} },
        interrupt_authorization: { id: "allow_all", options: {} },
        capability_ports: {
          artifacts: {
            id: "artifacts.manifest_store",
            options: { backend: "memory.artifacts" }
          }
        }
      }, {
        capabilityRegistry: createCapabilityRegistry([artifactsManifest]),
        agentRuntimeFactories: piRuntimeFactories
      });

      expect(composition.agentRuntime.describe().id).toBe("pi");
      expect(composition.checkpointDurability).toEqual({
        backend_id: "sqlite.checkpoints",
        durable: true
      });
      expect(composition.capabilityPorts.artifacts).toMatchObject({
        id: "artifacts.manifest_store",
        options: { backend: "memory.artifacts" }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts an injected backend factory catalog for runtime extensions", async () => {
    const customEvents: RuntimeEventStore = {
      async append(input) {
        return { ...input, sequence: input.sequence ?? 1 };
      },
      list: vi.fn(async () => []),
      query: vi.fn(async () => [])
    };
    const backendFactories = defaultRuntimeBackendFactoryCatalog();

    const composition = createRuntimeComposition({
      mode: "test",
      backends: {
        artifacts: { id: "memory.artifacts", options: {} },
        events: { id: "custom.events", options: { label: "custom" } },
        interrupts: { id: "memory.interrupts", options: {} },
        checkpoints: { id: "memory.checkpoints", options: {} },
        runtime_logs: { id: "memory.runtime-log", options: {} }
      },
      agent_runtime: { id: "pi", options: {} },
      interrupt_authorization: { id: "allow_all", options: {} }
    }, {
      agentRuntimeFactories: piRuntimeFactories,
      backendFactories: {
        ...backendFactories,
        events: {
          ...backendFactories.events,
          "custom.events": {
            registration: {
              id: "custom.events",
              kind: "event",
              optionsSchema: z.object({ label: z.literal("custom") }).strict()
            },
            create: () => customEvents
          }
        }
      }
    });

    expect(composition.backends.events).toBe(customEvents);
  });

  it("materializes the configured workflow runtime through an injected factory", () => {
    const workflowRuntime = {
      run: vi.fn(),
      resume: vi.fn()
    };
    let checkpointContext:
      | {
          readonly checkpoints: {
            readonly backendId: string;
            readonly store: unknown;
          };
        }
      | undefined;

    const composition = createRuntimeComposition({
      mode: "test",
      backends: {
        artifacts: { id: "memory.artifacts", options: {} },
        events: { id: "memory.events", options: {} },
        interrupts: { id: "memory.interrupts", options: {} },
        checkpoints: { id: "memory.checkpoints", options: {} },
        runtime_logs: { id: "memory.runtime-log", options: {} }
      },
      workflow_runtime: { id: "custom.workflow-runtime", options: { label: "custom" } },
      agent_runtime: { id: "pi", options: {} },
      interrupt_authorization: { id: "allow_all", options: {} }
    }, {
      agentRuntimeFactories: piRuntimeFactories,
      workflowRuntimeFactories: {
        "custom.workflow-runtime": {
          id: "custom.workflow-runtime",
          create: vi.fn((options, context) => {
            expect(options).toEqual({ label: "custom" });
            checkpointContext = context;
            return workflowRuntime;
          })
        }
      }
    });

    expect(composition.workflowRuntime).toBe(workflowRuntime);
    expect(checkpointContext).toEqual({
      checkpoints: {
        backendId: "memory.checkpoints",
        store: composition.backends.checkpoints
      }
    });
  });

  it("validates capability port ids and options through the capability registry", () => {
    const registry = createCapabilityRegistry([artifactsManifest]);
    const baseConfig = {
      mode: "test" as const,
      backends: {
        artifacts: { id: "memory.artifacts", options: {} },
        events: { id: "memory.events", options: {} },
        interrupts: { id: "memory.interrupts", options: {} },
        checkpoints: { id: "memory.checkpoints", options: {} },
        runtime_logs: { id: "memory.runtime-log", options: {} }
      },
      agent_runtime: { id: "pi", options: {} },
      interrupt_authorization: { id: "allow_all", options: {} }
    };

    expect(() =>
      createRuntimeComposition({
        ...baseConfig,
        capability_ports: {
          missing: { id: "artifacts.missing", options: {} }
        }
      }, { capabilityRegistry: registry, agentRuntimeFactories: piRuntimeFactories })
    ).toThrowError(expect.objectContaining({ code: "runtime_backend_invalid" }));

    expect(() =>
      createRuntimeComposition({
        ...baseConfig,
        capability_ports: {
          artifacts: { id: "artifacts.manifest_store", options: {} }
        }
      }, { capabilityRegistry: registry, agentRuntimeFactories: piRuntimeFactories })
    ).toThrowError(expect.objectContaining({ code: "runtime_backend_invalid" }));
  });

});
