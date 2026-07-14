import { describe, expect, it } from "vitest";
import { capabilityManifest, type CapabilitySideEffectCategory } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { loadWorkflowDefinition } from "../../../src/core/workflow/definition.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
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

  it("resolves effects declared by nodes inside a durable loop", async () => {
    const capabilityId = "loop-image";
    const registrationId = `${capabilityId}.generate`;
    const policyId = `${capabilityId}.policy`;
    const operationId = `${capabilityId}.operation`;
    const registry = createCapabilityRegistry([capabilityManifest({
      id: capabilityId,
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
          side_effect_semantics: "read",
          side_effect_category: "model_call",
          side_effect_operation_ids: [operationId],
          idempotency_scope: "attempt",
          retry_semantics: "retry_forbidden"
        }
      }
    })]);
    const base = workflow(capabilityId, registrationId);
    const result = await resolveNativeStudioRunEffects({
      workflow: {
        ...base,
        graph: {
          nodes: [{
            id: "review_loop",
            type: "loop",
            body: {
              nodes: [
                { id: "generate_image", type: "built_in", uses: registrationId },
                {
                  id: "review",
                  type: "human_gate",
                  uses: "hitl.review",
                  after: ["generate_image"]
                }
              ]
            },
            repeat_when: { expression: "false" },
            result: { expression: "{}" }
          }]
        }
      },
      agentsRoot: "/not-read",
      capabilityRegistry: registry
    });

    expect(result.potential_effects).toContainEqual(expect.objectContaining({
      operation_id: operationId,
      category: "model_call",
      retry_semantics: "retry_forbidden",
      node_id: "review_loop/generate_image"
    }));
  });

  it("includes the real social workflow's loop agents and pi-imagegen effect", async () => {
    const social = await loadWorkflowDefinition("workflows", "social-post", {
      agentsRoot: "agents",
      capabilityRegistry: nativeLunaPlatformRegistrations.capabilityRegistry
    });
    const result = await resolveNativeStudioRunEffects({
      workflow: social,
      agentsRoot: "agents",
      capabilityRegistry: nativeLunaPlatformRegistrations.capabilityRegistry
    });

    expect(result.potential_effects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: "model_call",
        registration_id: "social-post-writer",
        node_id: "editorial/proposal"
      }),
      expect.objectContaining({
        category: "model_call",
        operation_id: "image-generation.generate",
        registration_id: "image-generation.generate",
        node_id: "editorial/image"
      }),
      expect.objectContaining({
        category: "external_write",
        operation_id: "social-post.publish",
        node_id: "publish"
      })
    ]));
  });

  it("attributes implementation pattern agents to their durable stages", async () => {
    const implementation = await loadWorkflowDefinition("workflows", "implementation", {
      agentsRoot: "agents",
      capabilityRegistry: nativeLunaPlatformRegistrations.capabilityRegistry
    });
    const result = await resolveNativeStudioRunEffects({
      workflow: implementation,
      agentsRoot: "agents",
      capabilityRegistry: nativeLunaPlatformRegistrations.capabilityRegistry
    });

    expect(result.potential_effects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        registration_id: "code-implementer",
        node_id: "pattern/implementation/worker",
        retry_semantics: "retry_forbidden"
      }),
      expect.objectContaining({
        registration_id: "change-reviewer",
        node_id: "pattern/implementation/reviewer:review"
      }),
      expect.objectContaining({
        registration_id: "change-acceptance-reviewer",
        node_id: "pattern/implementation/reviewer:acceptance"
      })
    ]));
  });

  it("attributes composed child effects to the parent runtime call boundary", async () => {
    const capabilityId = "child-write";
    const registrationId = `${capabilityId}.execute`;
    const policyId = `${capabilityId}.policy`;
    const operationId = `${capabilityId}.operation`;
    const registry = createCapabilityRegistry([capabilityManifest({
      id: capabilityId,
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
          side_effect_semantics: "write",
          side_effect_category: "external_write",
          side_effect_operation_ids: [operationId],
          idempotency_scope: "external_resource",
          retry_semantics: "retry_requires_adoption"
        }
      }
    })]);
    const child = workflow(capabilityId, registrationId);
    const parent = {
      ...workflow(capabilityId, registrationId),
      graph: {
        nodes: [{
          id: "child_call",
          type: "workflow" as const,
          workflow: child.id,
          input: {}
        }]
      },
      compositions: { [child.id]: child }
    };

    const result = await resolveNativeStudioRunEffects({
      workflow: parent,
      agentsRoot: "/not-read",
      capabilityRegistry: registry
    });
    expect(result.potential_effects).toContainEqual(expect.objectContaining({
      operation_id: operationId,
      node_id: "child_call",
      description: expect.stringContaining("child_call/effect")
    }));
  });
});
