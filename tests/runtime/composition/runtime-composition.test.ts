import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { manifest as artifactsManifest } from "../../../src/capabilities/artifacts/manifest.js";
import {
  createRuntimeCompositionForWorkflow,
  createRuntimeComposition,
  runtimeBackendManifests
} from "../../../src/runtime/composition/runtime-composition.js";

describe("runtime composition", () => {
  it("materializes configured concrete backends, Pi adapter, auth port, and LangGraph checkpointer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-composition-"));
    const checkpointFile = path.join(root, "checkpoints.sqlite");

    try {
      await mkdir(root, { recursive: true });
      const composition = createRuntimeComposition({
        mode: "production",
        backends: {
          artifacts: {
            id: "filesystem.artifacts",
            options: { root: path.join(root, "artifacts") }
          },
          events: {
            id: "filesystem.events",
            options: { root: path.join(root, "events") }
          },
          interrupts: { id: "memory.interrupts", options: {} },
          checkpoints: {
            id: "sqlite.checkpoints",
            options: { filePath: checkpointFile }
          },
          runtime_logs: {
            id: "filesystem.runtime-log",
            options: { root: path.join(root, "runtime-log") }
          }
        },
        agent_runtime: { id: "pi", options: {} },
        interrupt_authorization: { id: "allow_all", options: {} },
        capability_ports: {
          artifacts: {
            id: "artifacts.manifest_store",
            options: { backend: "filesystem.artifacts" }
          }
        }
      }, {
        capabilityRegistry: createCapabilityRegistry([artifactsManifest])
      });

      expect(composition.agentRuntime.describe().id).toBe("pi");
      await expect(
        composition.interruptAuthorization.authorizeResume(
          {
            interrupt_id: "interrupt-1",
            thread_id: "thread-1",
            checkpoint_id: "checkpoint-1",
            decision: "approve"
          },
          {
            id: "interrupt-1",
            run_id: "run-1",
            status: "pending",
            created_at: "2026-06-25T00:00:00.000Z",
            updated_at: "2026-06-25T00:00:00.000Z"
          }
        )
      ).resolves.toEqual({ allowed: true });
      expect(composition.langGraphCheckpointer).toBeDefined();
      expect(composition.checkpointDurability).toEqual({
        backend_id: "sqlite.checkpoints",
        durable: true
      });
      expect(composition.capabilityPorts.artifacts).toEqual({
        name: "artifacts",
        id: "artifacts.manifest_store",
        capability: "artifacts",
        options: { backend: "filesystem.artifacts" },
        lifecycle: ["validate", "open", "close"]
      });

      await composition.backends.checkpoints.save({
        thread_id: "thread-1",
        checkpoint_id: "checkpoint-1",
        state_schema_version: "2026-06",
        state: { state_schema_version: "2026-06" }
      });
      await expect(
        composition.backends.checkpoints.load("thread-1")
      ).resolves.toMatchObject({ checkpoint_id: "checkpoint-1" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates backend options against backend manifests before run materialization", () => {
    expect(() =>
      createRuntimeComposition({
        mode: "test",
        backends: {
          artifacts: { id: "filesystem.artifacts", options: {} },
          events: { id: "memory.events", options: {} },
          interrupts: { id: "memory.interrupts", options: {} },
          checkpoints: { id: "memory.checkpoints", options: {} },
          runtime_logs: { id: "memory.runtime-log", options: {} }
        },
        agent_runtime: { id: "pi", options: {} },
        interrupt_authorization: { id: "allow_all", options: {} }
      })
    ).toThrowError(expect.objectContaining({ code: "runtime_backend_invalid" }));
  });

  it("fails unsupported backend and runtime ids before creating a run", () => {
    expect(() =>
      createRuntimeComposition({
        mode: "test",
        backends: {
          artifacts: { id: "missing.artifacts", options: {} },
          events: { id: "memory.events", options: {} },
          interrupts: { id: "memory.interrupts", options: {} },
          checkpoints: { id: "memory.checkpoints", options: {} },
          runtime_logs: { id: "memory.runtime-log", options: {} }
        },
        agent_runtime: { id: "pi", options: {} },
        interrupt_authorization: { id: "allow_all", options: {} }
      })
    ).toThrowError(expect.objectContaining({ code: "runtime_backend_invalid" }));

    expect(() =>
      createRuntimeComposition({
        mode: "test",
        backends: {
          artifacts: { id: "memory.artifacts", options: {} },
          events: { id: "memory.events", options: {} },
          interrupts: { id: "memory.interrupts", options: {} },
          checkpoints: { id: "memory.checkpoints", options: {} },
          runtime_logs: { id: "memory.runtime-log", options: {} }
        },
        agent_runtime: { id: "not-pi", options: {} },
        interrupt_authorization: { id: "allow_all", options: {} }
      })
    ).toThrowError(expect.objectContaining({ code: "runtime_backend_invalid" }));
  });

  it("validates Pi runtime options through the runtime catalog", () => {
    expect(() =>
      createRuntimeComposition({
        mode: "test",
        backends: {
          artifacts: { id: "memory.artifacts", options: {} },
          events: { id: "memory.events", options: {} },
          interrupts: { id: "memory.interrupts", options: {} },
          checkpoints: { id: "memory.checkpoints", options: {} },
          runtime_logs: { id: "memory.runtime-log", options: {} }
        },
        agent_runtime: { id: "pi", options: { max_tool_iterations: 0 } },
        interrupt_authorization: { id: "allow_all", options: {} }
      })
    ).toThrowError(expect.objectContaining({ code: "runtime_backend_invalid" }));
  });

  it("validates capability port ids and options through the capability registry", () => {
    const registry = createCapabilityRegistry([artifactsManifest]);

    expect(() =>
      createRuntimeComposition({
        mode: "test",
        backends: {
          artifacts: { id: "memory.artifacts", options: {} },
          events: { id: "memory.events", options: {} },
          interrupts: { id: "memory.interrupts", options: {} },
          checkpoints: { id: "memory.checkpoints", options: {} },
          runtime_logs: { id: "memory.runtime-log", options: {} }
        },
        agent_runtime: { id: "pi", options: {} },
        interrupt_authorization: { id: "allow_all", options: {} },
        capability_ports: {
          missing: { id: "artifacts.missing", options: {} }
        }
      }, { capabilityRegistry: registry })
    ).toThrowError(expect.objectContaining({ code: "runtime_backend_invalid" }));

    expect(() =>
      createRuntimeComposition({
        mode: "test",
        backends: {
          artifacts: { id: "memory.artifacts", options: {} },
          events: { id: "memory.events", options: {} },
          interrupts: { id: "memory.interrupts", options: {} },
          checkpoints: { id: "memory.checkpoints", options: {} },
          runtime_logs: { id: "memory.runtime-log", options: {} }
        },
        agent_runtime: { id: "pi", options: {} },
        interrupt_authorization: { id: "allow_all", options: {} },
        capability_ports: {
          artifacts: { id: "artifacts.manifest_store", options: {} }
        }
      }, { capabilityRegistry: registry })
    ).toThrowError(expect.objectContaining({ code: "runtime_backend_invalid" }));
  });

  it("applies workflow durability requirements before composing a workflow run", () => {
    expect(() =>
      createRuntimeCompositionForWorkflow(
        {
          mode: "production",
          backends: {
            artifacts: { id: "memory.artifacts", options: {} },
            events: { id: "memory.events", options: {} },
            interrupts: { id: "memory.interrupts", options: {} },
            checkpoints: { id: "memory.checkpoints", options: {} },
            runtime_logs: { id: "memory.runtime-log", options: {} }
          },
          agent_runtime: { id: "pi", options: {} },
          interrupt_authorization: { id: "allow_all", options: {} }
        },
        {
          id: "custom-write-workflow",
          mode: "trusted_local_write",
          graph: { nodes: [] }
        },
        {}
      )
    ).toThrowError(expect.objectContaining({ code: "runtime_backend_invalid" }));
  });

  it("exposes selected backend manifests for audit/debug output", () => {
    expect(
      runtimeBackendManifests({
        artifacts: { id: "memory.artifacts", options: {} },
        events: { id: "memory.events", options: {} },
        interrupts: { id: "memory.interrupts", options: {} },
        checkpoints: { id: "memory.checkpoints", options: {} },
        runtime_logs: { id: "memory.runtime-log", options: {} }
      })
    ).toEqual([
      { id: "memory.artifacts", kind: "artifact_manifest", options: {} },
      { id: "memory.events", kind: "event", options: {} },
      { id: "memory.interrupts", kind: "interrupt", options: {} },
      { id: "memory.checkpoints", kind: "checkpoint", options: {} },
      { id: "memory.runtime-log", kind: "runtime_log", options: {} }
    ]);
  });
});
