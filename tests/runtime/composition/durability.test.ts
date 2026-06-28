import { describe, expect, it } from "vitest";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import {
  assertRuntimeDurabilityPolicy,
  classifyRuntimeDurabilityRequirements
} from "../../../src/runtime/composition/durability.js";

describe("runtime composition durability policy", () => {
  it("uses backend durability metadata instead of hardcoded backend ids", () => {
    expect(() =>
      assertRuntimeDurabilityPolicy({
        mode: "production",
        checkpointBackendId: "custom.durable-checkpoints",
        checkpointDurable: true,
        workflow: { id: "implementation", mode: "trusted_local_write" }
      })
    ).not.toThrow();
  });

  it("allows memory checkpointing for test-only runs", () => {
    expect(() =>
      assertRuntimeDurabilityPolicy({
        mode: "test",
        checkpointBackendId: "memory.checkpoints",
        workflow: { id: "implementation" },
        requiresHumanInterrupts: true,
        hasExternalSideEffects: true
      })
    ).not.toThrow();
  });

  it("requires durable checkpointing for production HITL and side-effect runs", () => {
    expect(() =>
      assertRuntimeDurabilityPolicy({
        mode: "production",
        checkpointBackendId: "memory.checkpoints",
        workflow: { id: "code-review" },
        requiresHumanInterrupts: true
      })
    ).toThrowError(expect.objectContaining({ code: "runtime_backend_invalid" }));

    expect(() =>
      assertRuntimeDurabilityPolicy({
        mode: "production",
        checkpointBackendId: "memory.checkpoints",
        workflow: { id: "code-review" },
        hasExternalSideEffects: true
      })
    ).toThrowError(expect.objectContaining({ code: "runtime_backend_invalid" }));
  });

  it("rejects memory-only checkpointing for production implementation/write workflows", () => {
    expect(() =>
      assertRuntimeDurabilityPolicy({
        mode: "production",
        checkpointBackendId: "memory.checkpoints",
        workflow: { id: "implementation", mode: "trusted_local_write" }
      })
    ).toThrowError(expect.objectContaining({ code: "runtime_backend_invalid" }));

    expect(() =>
      assertRuntimeDurabilityPolicy({
        mode: "production",
        checkpointBackendId: "sqlite.checkpoints",
        checkpointDurable: true,
        workflow: { id: "implementation", mode: "trusted_local_write" }
      })
    ).not.toThrow();
  });

  it("classifies workflow durability requirements from structural workflow and capability signals", () => {
    const registry = createCapabilityRegistry([
      capabilityManifest({
        id: "review",
        kind: "execution",
        version: "1.0.0",
        gates: {
          "review.approval": {
            id: "review.approval",
            input_schema: { type: "object" },
            decision_schema: { type: "object" },
            output_schema: { type: "object" },
            interrupt: "required"
          }
        },
        policies: {
          "review.write": {
            id: "review.write",
            config_schema: { type: "object" },
            side_effect_semantics: "write",
            side_effect_operation_ids: ["review.commit"],
            idempotency_scope: "run",
            retry_semantics: "retry_requires_adoption"
          }
        }
      })
    ]);

    expect(
      classifyRuntimeDurabilityRequirements({
        workflowDefinition: {
          id: "custom-workflow",
          mode: "trusted_local_write",
          graph: {
            nodes: [
              {
                id: "writer",
                type: "built_in",
                uses: "repository.commit",
                policies: [{ uses: "review.write" }]
              },
              {
                id: "approval",
                type: "pattern",
                uses: "agents.gated_loop",
                gates: [
                  {
                    id: "approval-gate",
                    type: "review.approval"
                  }
                ]
              },
              {
                id: "human",
                type: "human_gate",
                uses: "review.approval"
              }
            ]
          }
        },
        capabilityRegistry: registry
      })
    ).toEqual([
      "human_gate",
      "interrupt_gate",
      "trusted_local_write",
      "write_side_effect"
    ]);
  });
});
