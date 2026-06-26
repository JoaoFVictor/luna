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

  it("rejects duplicate capability ids, unknown dependencies, and cycles", () => {
    expect(() =>
      createCapabilityRegistry([
        executionManifest("dupe"),
        executionManifest("dupe", { version: "2026.06.26" })
      ])
    ).toThrow(expect.objectContaining({ code: "capability_duplicate_id" }));

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

  it("rejects invalid capability ids and dependency ids", () => {
    expect(() =>
      createCapabilityRegistry([executionManifest("Bad.Id")])
    ).toThrow(expect.objectContaining({ code: "capability_id_invalid" }));

    expect(() =>
      createCapabilityRegistry([
        executionManifest("feature", { depends_on: ["bad.dep"] })
      ])
    ).toThrow(expect.objectContaining({ code: "capability_id_invalid" }));
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

    expect(() =>
      validateCapabilityManifest(
        executionManifest("context", {
          built_ins: {
            collect_context: {
              id: "collect_context",
              input_schema: schema,
              output_schema: schema,
              required_ports: []
            }
          }
        })
      )
    ).toThrow(expect.objectContaining({ code: "capability_id_namespace" }));
  });

  it("rejects composition capabilities that define execution registrations or runtime state", () => {
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

    expect(() =>
      validateCapabilityManifest(
        capabilityManifest({
          id: "repository-write",
          kind: "composition",
          version: "2026.06.25",
          runtime_state: {
            channels: ["private"]
          }
        })
      )
    ).toThrow(expect.objectContaining({ code: "capability_manifest_forbidden" }));

    expect(() =>
      validateCapabilityManifest(
        capabilityManifest({
          id: "repository-write",
          kind: "composition",
          version: "2026.06.25",
          schemas: {
            "repository-write.hidden_shape": {
              id: "repository-write.hidden_shape",
              schema
            }
          }
        })
      )
    ).toThrow(expect.objectContaining({ code: "capability_composition_forbidden" }));
  });

  it("allows composition capabilities to provide dependencies, presets, docs, and explicit re-exports only", () => {
    const manifest = validateCapabilityManifest(
      capabilityManifest({
        id: "repository-write",
        kind: "composition",
        version: "2026.06.25",
        depends_on: ["git", "quality-gates"],
        presets: {
          default_policy_bundle: ["quality-gates.writer_review"]
        },
        docs: [{ title: "Repository writes", path: "docs/repository-write.md" }],
        re_exports: {
          built_ins: ["git.commit"],
          patterns: ["quality-gates.gated_agent_loop"]
        }
      })
    );

    expect(manifest.re_exports).toEqual({
      built_ins: ["git.commit"],
      patterns: ["quality-gates.gated_agent_loop"]
    });
  });

  it("rejects generic compiler hooks, arbitrary graph commands, and state channel fields on patterns", () => {
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

    expect(() =>
      validatePatternRegistration("quality-gates", {
        id: "quality-gates.gated_agent_loop",
        declaring_node_type: "pattern",
        input_schema: schema,
        output_schema: schema,
        expand: { type: "declaring_node_subgraph" },
        graph_commands: [{ type: "add_edge", from: "a", to: "b" }]
      })
    ).toThrow(expect.objectContaining({ code: "pattern_registration_forbidden" }));

    expect(() =>
      validatePatternRegistration("quality-gates", {
        id: "quality-gates.gated_agent_loop",
        declaring_node_type: "pattern",
        input_schema: schema,
        output_schema: schema,
        expand: { type: "declaring_node_subgraph" },
        state_channels: ["private_loop_state"]
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

  it("rejects closed-shape manifest fields that would add executor binding or compiler escape hatches", () => {
    for (const field of [
      "executor",
      "executors",
      "handler",
      "runtime_executor",
      "compile_step",
      "generic_compiler_hooks",
      "compiler_hooks",
      "graph_commands",
      "commands",
      "compiler_wide_transforms",
      "compiler_transforms",
      "state_channels",
      "state_schema",
      "runtime_state"
    ]) {
      expect(() =>
        validateCapabilityManifest(
          capabilityManifest({
            ...executionManifest("closed-shape"),
            [field]: ["forbidden"]
          })
        )
      ).toThrow(expect.objectContaining({ code: "capability_manifest_forbidden" }));
    }

    expect(() =>
      validateCapabilityManifest(
        capabilityManifest({
          id: "repository-write",
          kind: "composition",
          version: "2026.06.25",
          depends_on: [],
          graph_commands: [{ type: "add_edge" }]
        })
      )
    ).toThrow(expect.objectContaining({ code: "capability_manifest_forbidden" }));
  });

  it("requires registration map keys to equal registration ids", () => {
    expect(() =>
      validateCapabilityManifest(
        capabilityManifest({
          id: "cap",
          kind: "execution",
          version: "2026.06.25",
          built_ins: {
            "cap.x": {
              id: "cap.y",
              input_schema: schema,
              output_schema: schema
            }
          }
        })
      )
    ).toThrow(expect.objectContaining({ code: "capability_registration_id_mismatch" }));
  });

  it("rejects arbitrary fields on nested registrations", () => {
    expect(() =>
      validateCapabilityManifest(
        capabilityManifest({
          id: "cap",
          kind: "execution",
          version: "2026.06.25",
          built_ins: {
            "cap.x": {
              id: "cap.x",
              input_schema: schema,
              output_schema: schema,
              executor: "cap.x"
            }
          }
        })
      )
    ).toThrow(expect.objectContaining({ code: "capability_registration_forbidden" }));

    expect(() =>
      validateCapabilityManifest(
        capabilityManifest({
          id: "cap",
          kind: "execution",
          version: "2026.06.25",
          policies: {
            "cap.policy": {
              id: "cap.policy",
              config_schema: schema,
              handler: "cap.policy"
            }
          }
        })
      )
    ).toThrow(expect.objectContaining({ code: "capability_registration_forbidden" }));
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
              required_ports: ["ports.missing"]
            }
          }
        })
      ])
    ).toThrow(expect.objectContaining({ code: "capability_unresolved_reference" }));

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
              side_effect_policy: "ports.missing_policy"
            }
          }
        }),
        ports
      ])
    ).toThrow(expect.objectContaining({ code: "capability_unresolved_reference" }));

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

    expect(() =>
      createCapabilityRegistry([
        capabilityManifest({
          id: "repository-write",
          kind: "composition",
          version: "2026.06.25",
          depends_on: ["quality-gates"],
          presets: {
            default_policy_bundle: ["quality-gates.writer_review"]
          },
          re_exports: {
            patterns: ["quality-gates.gated_agent_loop"]
          }
        }),
        dependency
      ])
    ).not.toThrow();
  });

  it("loads official manifests as pure static declarations with repository-write as composition only", async () => {
    const before = Object.getOwnPropertyNames(globalThis);
    const [
      { manifest: agentsManifest },
      { manifest: artifactsManifest },
      { manifest: contextManifest },
      { manifest: runtimeManifest },
      { manifest: reportsManifest },
      { manifest: qualityGatesManifest },
      { manifest: localExecManifest },
      { manifest: repositoryWorkspaceManifest },
      { manifest: gitManifest },
      { manifest: changeRequestManifest },
      { manifest: repositoryWriteManifest }
    ] = await Promise.all([
      import("../../../src/capabilities/agents/manifest.js"),
      import("../../../src/capabilities/artifacts/manifest.js"),
      import("../../../src/capabilities/context/manifest.js"),
      import("../../../src/capabilities/runtime/manifest.js"),
      import("../../../src/capabilities/reports/manifest.js"),
      import("../../../src/capabilities/quality-gates/manifest.js"),
      import("../../../src/capabilities/local-exec/manifest.js"),
      import("../../../src/capabilities/repository-workspace/manifest.js"),
      import("../../../src/capabilities/git/manifest.js"),
      import("../../../src/capabilities/change-request/manifest.js"),
      import("../../../src/capabilities/repository-write/manifest.js")
    ]);
    const after = Object.getOwnPropertyNames(globalThis);

    expect(after).toEqual(before);
    expect(contextManifest.built_ins?.["context.collect_context"]).toMatchObject({
      id: "context.collect_context"
    });
    expect(contextManifest.built_ins?.["context.collect_context"]).not.toHaveProperty(
      "executor"
    );

    const registry = createCapabilityRegistry([
      agentsManifest,
      artifactsManifest,
      contextManifest,
      runtimeManifest,
      reportsManifest,
      qualityGatesManifest,
      localExecManifest,
      repositoryWorkspaceManifest,
      gitManifest,
      changeRequestManifest,
      repositoryWriteManifest
    ]);
    const ids = registry.orderedManifests().map((manifest) => manifest.id);

    expect(ids).toEqual([
      "agents",
      "artifacts",
      "context",
      "runtime",
      "reports",
      "quality-gates",
      "local-exec",
      "repository-workspace",
      "git",
      "change-request",
      "repository-write"
    ]);
    expect(registry.get("repository-write")).toMatchObject({
      kind: "composition",
      depends_on: [
        "local-exec",
        "repository-workspace",
        "git",
        "change-request",
        "quality-gates"
      ]
    });
    expect(registry.get("repository-write").built_ins).toBeUndefined();
    expect(registry.get("repository-write").patterns).toBeUndefined();
    expect(registry.get("repository-write").tools).toBeUndefined();
    expect(registry.get("repository-write").gates).toBeUndefined();
    expect(registry.get("repository-write").policies).toBeUndefined();
    expect(registry.get("repository-write").ports).toBeUndefined();
    expect(registry.get("repository-write").artifact_publishers).toBeUndefined();
  });
});
