import { describe, expect, it } from "vitest";
import {
  capabilityManifest,
  type CapabilityManifest
} from "../../../src/core/capabilities/manifest.js";
import {
  createCapabilityRegistry
} from "../../../src/core/capabilities/registry.js";
import {
  validateCapabilityManifest,
  validatePatternRegistration
} from "../../../src/core/capabilities/validation.js";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    value: { type: "string" }
  }
} as const;

function executionManifest(
  id: string,
  overrides: Partial<CapabilityManifest> = {}
): CapabilityManifest {
  return capabilityManifest({
    id,
    kind: "execution",
    version: "2026.06.25",
    built_ins: {
      [`${id}.do_work`]: {
        id: `${id}.do_work`,
        input_schema: schema,
        output_schema: schema,
        required_ports: []
      }
    },
    ...overrides
  });
}

describe("capability registry", () => {
  it("orders explicit dependencies before dependents", () => {
    const base = executionManifest("base");
    const feature = executionManifest("feature", { depends_on: ["base"] });

    const registry = createCapabilityRegistry([feature, base]);

    expect(registry.orderedManifests().map((manifest) => manifest.id)).toEqual([
      "base",
      "feature"
    ]);
    expect(registry.get("feature")).toBe(feature);
  });

  it("rejects unknown dependencies and cycles", () => {
    expect(() =>
      createCapabilityRegistry([
        executionManifest("feature", { depends_on: ["missing"] })
      ])
    ).toThrow(expect.objectContaining({ code: "capability_unknown_dependency" }));

    expect(() =>
      createCapabilityRegistry([
        executionManifest("a", { depends_on: ["b"] }),
        executionManifest("b", { depends_on: ["a"] })
      ])
    ).toThrow(expect.objectContaining({ code: "capability_dependency_cycle" }));
  });

  it("requires capability-provided ids to be namespaced by the owning capability", () => {
    expect(() =>
      validateCapabilityManifest(
        executionManifest("context", {
          built_ins: {
            "other.collect_context": {
              id: "other.collect_context",
              input_schema: schema,
              output_schema: schema,
              required_ports: []
            }
          }
        })
      )
    ).toThrow(expect.objectContaining({ code: "capability_id_namespace" }));
  });

  it("rejects composition capabilities that define execution registrations", () => {
    expect(() =>
      validateCapabilityManifest(
        capabilityManifest({
          id: "repository-write",
          kind: "composition",
          version: "2026.06.25",
          depends_on: ["git"],
          built_ins: {
            "repository-write.commit": {
              id: "repository-write.commit",
              input_schema: schema,
              output_schema: schema,
              required_ports: []
            }
          }
        })
      )
    ).toThrow(expect.objectContaining({ code: "capability_composition_forbidden" }));
  });

  it("rejects compiler escape hatches on patterns", () => {
    expect(() =>
      validatePatternRegistration("quality-gates", {
        id: "quality-gates.gated_agent_loop",
        declaring_node_type: "pattern",
        input_schema: schema,
        output_schema: schema,
        expand: { type: "declaring_node_subgraph" },
        compiler_hooks: ["before_compile"]
      })
    ).toThrow(expect.objectContaining({ code: "pattern_registration_forbidden" }));
  });

  it("rejects domain built-ins under the reserved core namespace", () => {
    expect(() =>
      validateCapabilityManifest(
        capabilityManifest({
          id: "core",
          kind: "execution",
          version: "2026.06.25",
          built_ins: {
            "core.collect_context": {
              id: "core.collect_context",
              input_schema: schema,
              output_schema: schema,
              required_ports: []
            }
          }
        })
      )
    ).toThrow(expect.objectContaining({ code: "capability_core_reserved" }));
  });

  it("rejects duplicate registration ids across registration kinds", () => {
    expect(() =>
      createCapabilityRegistry([
        capabilityManifest({
          id: "cap",
          kind: "execution",
          version: "2026.06.25",
          built_ins: {
            "cap.same": {
              id: "cap.same",
              input_schema: schema,
              output_schema: schema
            }
          },
          policies: {
            "cap.same": {
              id: "cap.same",
              config_schema: schema
            }
          }
        })
      ])
    ).toThrow(
      expect.objectContaining({ code: "capability_duplicate_registration_id" })
    );
  });

  it("resolves one capability owner per intrinsic workflow node type", () => {
    const modelExecution = executionManifest("model-execution", {
      workflow_node_types: ["agent"]
    });

    expect(createCapabilityRegistry([modelExecution])
      .workflowNodeCapability("agent")).toBe(modelExecution);
    expect(() => createCapabilityRegistry([
      modelExecution,
      executionManifest("other-model", { workflow_node_types: ["agent"] })
    ])).toThrow(expect.objectContaining({
      code: "capability_duplicate_workflow_node_type"
    }));
  });

  it("accepts canonical local tool mode and safety authority", () => {
    const manifest = capabilityManifest({
      id: "repository",
      kind: "execution",
      version: "2026.06.25",
      tools: {
        "repository.write-file": {
          id: "repository.write-file",
          protocol: "local",
          input_schema: schema,
          output_schema: schema,
          runtime_requirements: ["tool_calling"],
          materialization: "local",
          allowed_agent_modes: ["trusted_local_write"],
          safety: {
            localWrites: true,
            network: false,
            externalSideEffects: false
          }
        }
      }
    });

    expect(validateCapabilityManifest(manifest)).toBe(manifest);
  });

  it("resolves built-in port and side-effect policy references only from local registrations or explicit dependencies", () => {
    const ports = capabilityManifest({
      id: "ports",
      kind: "execution",
      version: "2026.06.25",
      ports: {
        "ports.command": {
          id: "ports.command",
          capability: "ports",
          option_schema: schema
        }
      },
      policies: {
        "ports.write_policy": {
          id: "ports.write_policy",
          config_schema: schema
        }
      }
    });

    expect(() =>
      createCapabilityRegistry([
        executionManifest("feature", {
          built_ins: {
            "feature.do_work": {
              id: "feature.do_work",
              input_schema: schema,
              output_schema: schema,
              required_ports: ["ports.command"],
              side_effect_policy: "ports.write_policy"
            }
          }
        }),
        ports
      ])
    ).toThrow(expect.objectContaining({ code: "capability_reference_not_declared" }));

    expect(() =>
      createCapabilityRegistry([
        executionManifest("feature", {
          depends_on: ["ports"],
          built_ins: {
            "feature.do_work": {
              id: "feature.do_work",
              input_schema: schema,
              output_schema: schema,
              required_ports: ["ports.command"],
              side_effect_policy: "ports.write_policy"
            }
          }
        }),
        ports
      ])
    ).not.toThrow();
  });

  it("validates registered side-effect operation ids across capabilities", () => {
    expect(() =>
      createCapabilityRegistry([
        executionManifest("categorized", {
          policies: {
            "categorized.policy": {
              id: "categorized.policy",
              config_schema: schema,
              side_effect_category: "external_write"
            }
          }
        })
      ])
    ).toThrow(
      expect.objectContaining({ code: "capability_side_effect_policy_invalid" })
    );

    expect(() =>
      createCapabilityRegistry([
        executionManifest("local-exec", {
          policies: {
            "local-exec.command": {
              id: "local-exec.command",
              config_schema: schema,
              side_effect_semantics: "write",
              retry_semantics: "retry_requires_adoption"
            }
          }
        })
      ])
    ).toThrow(
      expect.objectContaining({ code: "capability_side_effect_policy_invalid" })
    );

    expect(() =>
      createCapabilityRegistry([
        executionManifest("git", {
          policies: {
            "git.write": {
              id: "git.write",
              config_schema: schema,
              side_effect_semantics: "write",
              side_effect_operation_ids: ["git.commit"],
              idempotency_scope: "external_resource",
              retry_semantics: "retry_requires_adoption"
            },
            "git.write_again": {
              id: "git.write_again",
              config_schema: schema,
              side_effect_semantics: "write",
              side_effect_operation_ids: ["git.commit"],
              idempotency_scope: "external_resource",
              retry_semantics: "retry_requires_adoption"
            }
          }
        })
      ])
    ).toThrow(
      expect.objectContaining({
        code: "capability_duplicate_side_effect_operation_id"
      })
    );

    expect(() =>
      createCapabilityRegistry([
        executionManifest("hidden-effect", {
          policies: {
            "hidden-effect.policy": {
              id: "hidden-effect.policy",
              config_schema: schema,
              side_effect_operation_ids: ["hidden-effect.publish"]
            }
          }
        })
      ])
    ).toThrow(
      expect.objectContaining({ code: "capability_side_effect_policy_invalid" })
    );

    expect(() =>
      createCapabilityRegistry([
        executionManifest("unbound-read", {
          policies: {
            "unbound-read.policy": {
              id: "unbound-read.policy",
              config_schema: schema,
              side_effect_semantics: "read"
            }
          }
        })
      ])
    ).toThrow(
      expect.objectContaining({ code: "capability_side_effect_policy_invalid" })
    );
  });

  it("resolves presets and re-exports only from explicit dependencies", () => {
    const dependency = capabilityManifest({
      id: "quality-gates",
      kind: "execution",
      version: "2026.06.25",
      patterns: {
        "quality-gates.gated_agent_loop": {
          id: "quality-gates.gated_agent_loop",
          declaring_node_type: "pattern",
          input_schema: schema,
          output_schema: schema,
          expand: { type: "declaring_node_subgraph" }
        }
      },
      policies: {
        "quality-gates.writer_review": {
          id: "quality-gates.writer_review",
          config_schema: schema
        }
      }
    });

    expect(() =>
      createCapabilityRegistry([
        capabilityManifest({
          id: "repository-write",
          kind: "composition",
          version: "2026.06.25",
          depends_on: ["quality-gates"],
          presets: {
            default_policy_bundle: ["quality-gates.missing_policy"]
          }
        }),
        dependency
      ])
    ).toThrow(expect.objectContaining({ code: "capability_unresolved_reference" }));

    expect(() =>
      createCapabilityRegistry([
        capabilityManifest({
          id: "repository-write",
          kind: "composition",
          version: "2026.06.25",
          re_exports: {
            patterns: ["quality-gates.gated_agent_loop"]
          }
        }),
        dependency
      ])
    ).toThrow(expect.objectContaining({ code: "capability_reference_not_declared" }));

  });

});
