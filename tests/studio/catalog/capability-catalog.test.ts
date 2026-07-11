import { describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { StudioPresentationSchema } from "../../../src/core/capabilities/studio-presentation.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { createStudioCapabilityCatalog } from "../../../src/studio/application/catalog/capability-catalog.js";
import { StudioRegistrationPresentationSchema } from "../../../src/studio/contracts/capability-catalog.js";

function registryWithPresentation(title: string) {
  return createCapabilityRegistry([
    capabilityManifest({
      id: "sample",
      kind: "execution",
      version: "1.0.0",
      presentation: { title: "Sample capability" },
      built_ins: {
        "sample.inspect": {
          id: "sample.inspect",
          input_schema: {
            type: "object",
            properties: {
              level: {
                type: "string",
                enum: ["brief", "full"]
              }
            }
          },
          output_schema: { type: "object" },
          presentation: {
            title,
            field_hints: {
              "/properties/level": {
                control: "select",
                option_labels: {
                  brief: "Brief",
                  full: "Full"
                }
              }
            }
          }
        }
      }
    })
  ]);
}

function registryWithTechnicalCapability(options: {
  readonly version: string;
  readonly kind: "execution" | "composition";
  readonly dependsOn: readonly string[];
}) {
  return createCapabilityRegistry([
    capabilityManifest({
      id: "base",
      kind: "execution",
      version: "1.0.0",
      presentation: { title: "Base" }
    }),
    capabilityManifest({
      id: "sample",
      kind: options.kind,
      version: options.version,
      depends_on: options.dependsOn,
      presentation: { title: "Sample" },
      docs: [
        {
          title: "Sample documentation",
          path: "docs/sample.md",
          url: "https://example.test/sample"
        }
      ]
    })
  ]);
}

describe("Studio capability catalog", () => {
  it("projects the effectively loaded native platform registry", () => {
    const catalog = createStudioCapabilityCatalog(
      nativeLunaPlatformRegistrations.capabilityRegistry
    );

    expect(catalog.capabilities.length).toBeGreaterThan(0);
    expect(catalog.registrations.length).toBeGreaterThan(0);
    expect(catalog.registrations.some(
      (registration) => registration.registration_kind === "pattern"
    )).toBe(true);
    expect(catalog.registrations.find(
      (registration) => registration.id === "repository.write-file"
    )).toMatchObject({
      registration_kind: "tool",
      protocol: "local",
      allowed_agent_modes: ["trusted_local_write"],
      safety: {
        local_writes: true,
        network: false,
        external_side_effects: false
      }
    });
  });

  it("projects loaded registrations into explicit discriminated DTOs", () => {
    const catalog = createStudioCapabilityCatalog(
      registryWithPresentation("Inspect")
    );

    expect(catalog.capabilities).toMatchObject([
      {
        id: "sample",
        version: "1.0.0",
        presentation: { title: "Sample capability" }
      }
    ]);
    expect(catalog.registrations).toMatchObject([
      {
        registration_kind: "built_in",
        id: "sample.inspect",
        owner: { capability_id: "sample" },
        presentation: { title: "Inspect" },
        required_ports: []
      }
    ]);
  });

  it("projects workflow node ownership from registry semantics instead of public ids", () => {
    const registry = createCapabilityRegistry([
      capabilityManifest({
        id: "model-execution",
        kind: "execution",
        version: "1.0.0",
        workflow_node_types: ["agent"]
      })
    ]);

    expect(createStudioCapabilityCatalog(registry).capabilities).toEqual([
      expect.objectContaining({
        id: "model-execution",
        workflow_node_types: ["agent"]
      })
    ]);
  });

  it("projects capability presets and re-exports without a parallel UI registry", () => {
    const registry = createCapabilityRegistry([
      capabilityManifest({
        id: "base",
        kind: "execution",
        version: "1.0.0",
        built_ins: {
          "base.inspect": {
            id: "base.inspect",
            input_schema: { type: "object" },
            output_schema: { type: "object" }
          }
        }
      }),
      capabilityManifest({
        id: "sample",
        kind: "composition",
        version: "2.0.0",
        depends_on: ["base"],
        presets: { default: ["base.inspect"] },
        re_exports: { built_ins: ["base.inspect"] }
      })
    ]);

    expect(createStudioCapabilityCatalog(registry).capabilities).toContainEqual(
      expect.objectContaining({
        id: "sample",
        presets: { default: ["base.inspect"] },
        re_exports: {
          built_ins: ["base.inspect"],
          patterns: [],
          tools: [],
          gates: [],
          policies: [],
          ports: [],
          artifact_publishers: []
        }
      })
    );
  });

  it("keeps technical and presentation invalidation independent", () => {
    const before = createStudioCapabilityCatalog(
      registryWithPresentation("Inspect")
    );
    const relabeled = createStudioCapabilityCatalog(
      registryWithPresentation("Inspect files")
    );

    expect(relabeled.technical_fingerprint).toBe(
      before.technical_fingerprint
    );
    expect(relabeled.presentation_fingerprint).not.toBe(
      before.presentation_fingerprint
    );
  });

  it("includes local tool mode and safety authority in the technical fingerprint", () => {
    const registry = (allowedModes: readonly ("read_only" | "trusted_local_write")[]) =>
      createCapabilityRegistry([
        capabilityManifest({
          id: "repository",
          kind: "execution",
          version: "1.0.0",
          tools: {
            "repository.edit": {
              id: "repository.edit",
              protocol: "local",
              input_schema: { type: "object" },
              output_schema: { type: "object" },
              allowed_agent_modes: allowedModes,
              safety: {
                localWrites: allowedModes.length === 1,
                network: false,
                externalSideEffects: false
              }
            }
          }
        })
      ]);
    const readOnly = createStudioCapabilityCatalog(
      registry(["read_only", "trusted_local_write"])
    );
    const writeOnly = createStudioCapabilityCatalog(
      registry(["trusted_local_write"])
    );

    expect(writeOnly.technical_fingerprint).not.toBe(
      readOnly.technical_fingerprint
    );
    expect(writeOnly.presentation_fingerprint).toBe(
      readOnly.presentation_fingerprint
    );
  });

  it("does not invalidate presentation for technical-only manifest changes", () => {
    const before = createStudioCapabilityCatalog(
      registryWithTechnicalCapability({
        version: "1.0.0",
        kind: "execution",
        dependsOn: []
      })
    );
    const changed = createStudioCapabilityCatalog(
      registryWithTechnicalCapability({
        version: "2.0.0",
        kind: "composition",
        dependsOn: ["base"]
      })
    );

    expect(changed.technical_fingerprint).not.toBe(
      before.technical_fingerprint
    );
    expect(changed.presentation_fingerprint).toBe(
      before.presentation_fingerprint
    );
  });

  it.each([
    ["an absolute documentation path", { path: "/home/user/private.md" }],
    ["a file documentation URI", { url: "file:///home/user/private.md" }]
  ])("rejects %s from the public catalog", (_label, reference) => {
    const registry = createCapabilityRegistry([
      capabilityManifest({
        id: "unsafe-docs",
        kind: "execution",
        version: "1.0.0",
        docs: [{ title: "Unsafe documentation", ...reference }]
      })
    ]);

    expect(() => createStudioCapabilityCatalog(registry)).toThrow();
  });

  it("reuses the canonical core presentation contract", () => {
    expect(StudioRegistrationPresentationSchema).toBe(
      StudioPresentationSchema
    );
    expect(
      StudioRegistrationPresentationSchema.safeParse({
        title: "Invalid fragment pointer",
        field_hints: {
          "#/properties/mode": { control: "select" }
        }
      }).success
    ).toBe(false);
    expect(
      StudioRegistrationPresentationSchema.safeParse({
        title: "Invalid empty option label",
        field_hints: {
          "/properties/mode": {
            control: "select",
            option_labels: { read: "" }
          }
        }
      }).success
    ).toBe(false);
  });

  it("uses public ids as presentation fallback without inventing semantics", () => {
    const registry = createCapabilityRegistry([
      capabilityManifest({
        id: "plain",
        kind: "execution",
        version: "1.0.0",
        schemas: {
          "plain.result": {
            id: "plain.result",
            schema: { type: "object" }
          }
        }
      })
    ]);

    const catalog = createStudioCapabilityCatalog(registry);

    expect(catalog.capabilities[0]?.presentation).toEqual({ title: "plain" });
    expect(catalog.registrations[0]?.presentation).toEqual({
      title: "plain.result"
    });
  });
});
