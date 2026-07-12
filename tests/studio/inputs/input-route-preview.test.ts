import { describe, expect, it } from "vitest";
import { defineInputAdapters } from "../../../src/adapters/registry.js";
import { defineStudioAdapterPreviewPort } from "../../../src/studio/application/inputs/adapter-preview-port.js";
import { previewStudioInputRoute } from "../../../src/studio/application/inputs/input-route-preview.js";
import { isolatedStudioRoutingSimulationPort } from "../../../src/studio/application/routing/routing-simulator.js";

describe("Studio adapter routing preview", () => {
  it("routes with the private invocation and returns only its public projection", async () => {
    const adapter = {
      id: "private-payload",
      description: "Adapter with private routing payload",
      source: "private-source",
      loadEffects: [] as const,
      async load() {
        throw new Error("The raw adapter must not execute from Studio preview");
      }
    };
    const registry = defineInputAdapters([adapter]);
    const previews = defineStudioAdapterPreviewPort(registry, [
      {
        adapterId: adapter.id,
        effects: [],
        timeoutMs: 1_000,
        async preview() {
          return {
            version: "2026-06",
            source: adapter.source,
            event: "selected",
            payload: { routing_key: "private-match", secret: "never-public" }
          };
        }
      }
    ]);

    const result = await previewStudioInputRoute(
      {
        adapter_id: adapter.id,
        input: { kind: "cli", value: "opaque" },
        acknowledged_effects: []
      },
      {
        registry,
        previews,
        routingSimulator: isolatedStudioRoutingSimulationPort,
        routing: {
          type: "router",
          version: "2026-06",
          rules: [
            {
              id: "private-payload-rule",
              when: {
                expression:
                  "$.invocation.payload.routing_key = 'private-match'"
              },
              target: "workflow:private-workflow"
            }
          ]
        }
      }
    );

    expect(result.routing.target).toEqual({
      type: "workflow",
      id: "private-workflow"
    });
    expect(result.adapter.redacted_fields).toEqual(["payload"]);
    expect(result.adapter.invocation).not.toHaveProperty("payload");
    expect(JSON.stringify(result)).not.toContain("never-public");
    expect(JSON.stringify(result)).not.toContain("private-match");
  });
});
