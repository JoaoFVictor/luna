import { describe, expect, it } from "vitest";
import { capabilityManifest, type CapabilitySideEffectCategory } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { resolveNativeStudioRunEffects } from "../../../src/studio/adapters/native/run-effect-resolution.js";

function workflow(
  capabilityId: string,
  registrationId: string
): WorkflowDefinition {
  return {
    id: "effect-category-test",
    type: "workflow",
    mode: "read_only",
    directory: "/not-read",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: { type: "object" },
    output_schema_content: { type: "object" },
    capabilities: [capabilityId],
    graph: {
      nodes: [{ id: "effect", type: "built_in", uses: registrationId }]
    },
    revision: "sha256:test",
    external_definition_digests: {},
    execution: { max_concurrency: 1 },
    requires: { repository: false },
    observability: {
      exporters: { runtime_log: { enabled: true, required: false } }
    },
    subagent_policy: { allow_write: false }
  };
}

async function resolvedCategory(input: {
  readonly capabilityId: string;
  readonly semantics: "read" | "write";
  readonly category?: CapabilitySideEffectCategory;
}): Promise<CapabilitySideEffectCategory> {
  const registrationId = `${input.capabilityId}.execute`;
  const policyId = `${input.capabilityId}.policy`;
  const operationId = `${input.capabilityId}.operation`;
  const registry = createCapabilityRegistry([
    capabilityManifest({
      id: input.capabilityId,
      kind: "execution",
      version: "1.0.0",
      built_ins: {
        [registrationId]: {
          id: registrationId,
          input_schema: { type: "object" },
          output_schema: { type: "object" },
          side_effect_policy: policyId
        }
      },
      policies: {
        [policyId]: {
          id: policyId,
          config_schema: { type: "object" },
          side_effect_semantics: input.semantics,
          ...(input.category === undefined
            ? {}
            : { side_effect_category: input.category }),
          side_effect_operation_ids: [operationId],
          idempotency_scope: "attempt",
          retry_semantics: input.semantics === "write"
            ? "retry_requires_adoption"
            : "replay_safe"
        }
      }
    })
  ]);
  const result = await resolveNativeStudioRunEffects({
    workflow: workflow(input.capabilityId, registrationId),
    agentsRoot: "/not-read",
    capabilityRegistry: registry
  });
  const effect = result.potential_effects.find(
    (candidate) => candidate.operation_id === operationId
  );
  if (effect === undefined) {
    throw new Error("expected declared effect");
  }
  return effect.category;
}

describe("native Studio effect categories", () => {
  it.each([
    ["opaque-repository", "write", "repository_write"],
    ["opaque-external", "write", "external_write"],
    ["opaque-process", "read", "local_process"],
    ["opaque-provider", "read", "provider_read"],
    ["opaque-other", "read", "other"]
  ] as const)(
    "uses declarative category for arbitrary capability %s",
    async (capabilityId, semantics, category) => {
      await expect(resolvedCategory({
        capabilityId,
        semantics,
        category
      })).resolves.toBe(category);
    }
  );

  it("uses conservative fallbacks without inspecting operation prefixes", async () => {
    await expect(resolvedCategory({
      capabilityId: "local-exec-lookalike",
      semantics: "write"
    })).resolves.toBe("external_write");
    await expect(resolvedCategory({
      capabilityId: "git-lookalike",
      semantics: "read"
    })).resolves.toBe("provider_read");
  });
});
