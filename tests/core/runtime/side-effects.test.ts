import { describe, expect, it } from "vitest";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import {
  assertSideEffectingOperationsHavePolicies,
  createSideEffectPolicy,
  createSideEffectRegistry,
  deriveIdempotencyKey,
  validateRetrySemantics
} from "../../../src/core/runtime/side-effects.js";
import { loadWorkflowDefinitionFromMetadata } from "../../../src/core/workflow/definition.js";
import type { WorkflowMetadata } from "../../../src/core/workflow/definition.js";

describe("runtime side-effect policies", () => {
  it("derives stable idempotency keys from run, node, attempt, and capability operation id", () => {
    const policy = createSideEffectPolicy({
      capability_id: "git",
      operation_id: "git.commit_changes",
      idempotency_scope: "attempt",
      retry_semantics: "retry_requires_adoption",
      adoption_required: true
    });

    expect(policy).toEqual({
      capability_id: "git",
      operation_id: "git.commit_changes",
      idempotency_scope: "attempt",
      retry_semantics: "retry_requires_adoption",
      adoption_required: true
    });
    expect(
      deriveIdempotencyKey(policy, {
        run_id: "run-1",
        node_id: "commit",
        attempt: 2
      })
    ).toMatch(/^side-effect:[a-f0-9]{64}$/);
  });

  it("derives structured idempotency keys with full workflow identity", () => {
    const runPolicy = createSideEffectPolicy({
      capability_id: "context",
      operation_id: "context.collect",
      idempotency_scope: "run",
      retry_semantics: "replay_safe",
      adoption_required: false
    });
    const nodePolicy = createSideEffectPolicy({
      capability_id: "router",
      operation_id: "router.route",
      idempotency_scope: "node",
      retry_semantics: "replay_safe",
      adoption_required: false
    });
    const attemptPolicy = createSideEffectPolicy({
      capability_id: "git",
      operation_id: "git.commit_changes",
      idempotency_scope: "attempt",
      retry_semantics: "retry_requires_adoption",
      adoption_required: true
    });
    const externalPolicy = createSideEffectPolicy({
      capability_id: "storage",
      operation_id: "storage.upload",
      idempotency_scope: "external_resource",
      retry_semantics: "replay_safe",
      adoption_required: false
    });

    expect(
      deriveIdempotencyKey(runPolicy, {
        run_id: "run/1",
        node_id: "node/a",
        attempt: 1
      })
    ).not.toBe(
      deriveIdempotencyKey(runPolicy, {
        run_id: "run/1",
        node_id: "node/b",
        attempt: 2
      })
    );
    expect(
      deriveIdempotencyKey(nodePolicy, {
        run_id: "run/1",
        node_id: "node/a",
        attempt: 1
      })
    ).not.toBe(
      deriveIdempotencyKey(nodePolicy, {
        run_id: "run/1",
        node_id: "node/a",
        attempt: 2
      })
    );
    expect(
      deriveIdempotencyKey(attemptPolicy, {
        run_id: "run/1",
        node_id: "node/a",
        attempt: 1
      })
    ).not.toBe(
      deriveIdempotencyKey(attemptPolicy, {
        run_id: "run",
        node_id: "1/node/a",
        attempt: 1
      })
    );
    expect(() =>
      deriveIdempotencyKey(externalPolicy, {
        run_id: "run-1",
        node_id: "upload",
        attempt: 1
      })
    ).toThrow(
      expect.objectContaining({ code: "side_effect_external_resource_missing" })
    );
    expect(
      deriveIdempotencyKey(externalPolicy, {
        run_id: "run-1",
        node_id: "upload",
        attempt: 1,
        external_resource_id: "bucket/key"
      })
    ).toMatch(/^side-effect:[a-f0-9]{64}$/);
    expect(
      deriveIdempotencyKey(externalPolicy, {
        run_id: "run-1",
        node_id: "upload",
        attempt: 1,
        external_resource_id: "bucket/key"
      })
    ).not.toBe(
      deriveIdempotencyKey(externalPolicy, {
        run_id: "run-2",
        node_id: "upload",
        attempt: 1,
        external_resource_id: "bucket/key"
      })
    );
  });

  it("requires operation ids to be namespaced by owning capability and collision-free", () => {
    expect(() =>
      createSideEffectPolicy({
        capability_id: "git",
        operation_id: "commit_changes",
        idempotency_scope: "attempt",
        retry_semantics: "replay_safe",
        adoption_required: false
      })
    ).toThrow(expect.objectContaining({ code: "side_effect_operation_id_invalid" }));

    expect(() =>
      createSideEffectRegistry([
        createSideEffectPolicy({
          capability_id: "git",
          operation_id: "git.commit_changes",
          idempotency_scope: "attempt",
          retry_semantics: "retry_requires_adoption",
          adoption_required: true
        }),
        createSideEffectPolicy({
          capability_id: "git",
          operation_id: "git.commit_changes",
          idempotency_scope: "attempt",
          retry_semantics: "retry_requires_adoption",
          adoption_required: true
        })
      ])
    ).toThrow(expect.objectContaining({ code: "side_effect_operation_duplicate" }));
  });

  it("rejects retry-requires-adoption policies without adoption enforcement", () => {
    expect(() =>
      createSideEffectPolicy({
        capability_id: "git",
        operation_id: "git.commit_changes",
        idempotency_scope: "attempt",
        retry_semantics: "retry_requires_adoption",
        adoption_required: false
      })
    ).toThrow(expect.objectContaining({ code: "side_effect_policy_invalid" }));
  });

  it("validates replay-safe, adoption-required, and forbidden retry semantics", () => {
    const replaySafe = createSideEffectPolicy({
      capability_id: "context",
      operation_id: "context.collect",
      idempotency_scope: "run",
      retry_semantics: "replay_safe",
      adoption_required: false
    });
    const adoptionRequired = createSideEffectPolicy({
      capability_id: "git",
      operation_id: "git.commit_changes",
      idempotency_scope: "attempt",
      retry_semantics: "retry_requires_adoption",
      adoption_required: true
    });
    const forbidden = createSideEffectPolicy({
      capability_id: "payments",
      operation_id: "payments.charge_card",
      idempotency_scope: "external_resource",
      retry_semantics: "retry_forbidden",
      adoption_required: false
    });

    expect(() => validateRetrySemantics(replaySafe, { attempt: 3 })).not.toThrow();
    expect(() =>
      validateRetrySemantics(adoptionRequired, {
        attempt: 2,
        adopted: false
      })
    ).toThrow(expect.objectContaining({ code: "side_effect_adoption_required" }));
    expect(() =>
      validateRetrySemantics(adoptionRequired, {
        attempt: 2,
        adopted: true
      })
    ).not.toThrow();
    expect(() => validateRetrySemantics(forbidden, { attempt: 2 })).toThrow(
      expect.objectContaining({ code: "side_effect_retry_forbidden" })
    );
  });

  it("rejects side-effecting workflow operations without a policy before start", () => {
    expect(() =>
      assertSideEffectingOperationsHavePolicies([
        {
          id: "git.commit",
          side_effecting: true,
          policy: createSideEffectPolicy({
            capability_id: "git",
            operation_id: "git.commit_changes",
            idempotency_scope: "attempt",
            retry_semantics: "retry_requires_adoption",
            adoption_required: true
          })
        },
        {
          id: "change-request.create",
          side_effecting: true
        }
      ])
    ).toThrow(expect.objectContaining({ code: "side_effect_policy_missing" }));
  });

  it("rejects side-effecting built-in workflow nodes without concrete policy config", async () => {
    const schema = { type: "object", additionalProperties: false } as const;
    const registry = createCapabilityRegistry([
      capabilityManifest({
        id: "effects",
        kind: "execution",
        version: "2026.06.26",
        built_ins: {
          "effects.publish": {
            id: "effects.publish",
            input_schema: schema,
            output_schema: schema,
            side_effect_policy: "effects.publish_policy"
          }
        },
        policies: {
          "effects.publish_policy": {
            id: "effects.publish_policy",
            config_schema: {
              type: "object",
              additionalProperties: false,
              required: ["operation_id"],
              properties: { operation_id: { type: "string" } }
            },
            side_effect_semantics: "write",
            side_effect_operation_ids: ["effects.publish"],
            idempotency_scope: "attempt",
            retry_semantics: "retry_requires_adoption"
          },
          "effects.other_policy": {
            id: "effects.other_policy",
            config_schema: {
              type: "object",
              additionalProperties: false,
              required: ["operation_id"],
              properties: { operation_id: { type: "string" } }
            },
            side_effect_semantics: "write",
            side_effect_operation_ids: ["effects.other"],
            idempotency_scope: "attempt",
            retry_semantics: "retry_requires_adoption"
          }
        }
      })
    ]);

    await expect(
      loadWorkflowDefinitionFromMetadata({
        directory: "tests/fixtures/workflows/minimum",
        workflowId: "side-effects",
        metadata: {
          id: "side-effects",
          type: "workflow",
          input_schema: "input.schema.json",
          output_schema: "output.schema.json",
          capabilities: ["effects"],
          nodes: [
            {
              id: "publish",
              type: "built_in",
              uses: "effects.publish"
            }
          ]
        } as WorkflowMetadata,
        capabilityRegistry: registry
      })
    ).rejects.toMatchObject({ code: "workflow_side_effect_policy_missing" });

    await expect(
      loadWorkflowDefinitionFromMetadata({
        directory: "tests/fixtures/workflows/minimum",
        workflowId: "side-effects",
        metadata: {
          id: "side-effects",
          type: "workflow",
          input_schema: "input.schema.json",
          output_schema: "output.schema.json",
          capabilities: ["effects"],
          nodes: [
            {
              id: "publish",
              type: "built_in",
              uses: "effects.publish",
              policies: [
                {
                  uses: "effects.publish_policy",
                  config: { operation_id: "other.publish" }
                }
              ]
            }
          ]
        } as WorkflowMetadata,
        capabilityRegistry: registry
      })
    ).rejects.toMatchObject({ code: "workflow_side_effect_policy_invalid" });

    await expect(
      loadWorkflowDefinitionFromMetadata({
        directory: "tests/fixtures/workflows/minimum",
        workflowId: "side-effects",
        metadata: {
          id: "side-effects",
          type: "workflow",
          input_schema: "input.schema.json",
          output_schema: "output.schema.json",
          capabilities: ["effects"],
          nodes: [
            {
              id: "publish",
              type: "built_in",
              uses: "effects.publish",
              policies: [
                {
                  uses: "effects.publish_policy",
                  config: { operation_id: "effects.unregistered" }
                }
              ]
            }
          ]
        } as WorkflowMetadata,
        capabilityRegistry: registry
      })
    ).rejects.toMatchObject({ code: "workflow_side_effect_policy_invalid" });

    await expect(
      loadWorkflowDefinitionFromMetadata({
        directory: "tests/fixtures/workflows/minimum",
        workflowId: "side-effects",
        metadata: {
          id: "side-effects",
          type: "workflow",
          input_schema: "input.schema.json",
          output_schema: "output.schema.json",
          capabilities: ["effects"],
          nodes: [
            {
              id: "publish_one",
              type: "built_in",
              uses: "effects.publish",
              policies: [
                {
                  uses: "effects.publish_policy",
                  config: { operation_id: "effects.publish" }
                }
              ]
            },
            {
              id: "publish_two",
              type: "built_in",
              uses: "effects.publish",
              policies: [
                {
                  uses: "effects.publish_policy",
                  config: { operation_id: "effects.publish" }
                }
              ]
            }
          ]
        } as WorkflowMetadata,
        capabilityRegistry: registry
      })
    ).resolves.toMatchObject({
      graph: { nodes: [{ id: "publish_one" }, { id: "publish_two" }] }
    });
  });
});
