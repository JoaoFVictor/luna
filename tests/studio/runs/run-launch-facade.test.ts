import { describe, expect, it, vi } from "vitest";
import type { RouterDefinition } from "../../../src/core/router/router-definition.js";
import {
  StudioRunLaunchFacade,
  type StudioInstalledRunDefinition
} from "../../../src/studio/application/runs/launch-facade.js";
import { studioRunValueDigest } from "../../../src/studio/application/runs/launch-digests.js";
import { isolatedStudioRoutingSimulationPort } from "../../../src/studio/application/routing/routing-simulator.js";
import type { StudioRoutingSimulationPort } from "../../../src/studio/application/routing/routing-simulator.js";
import {
  StudioRunPlanRequestSchema,
  type StudioRunPlan,
  type StudioRunPlanRequest
} from "../../../src/studio/contracts/run-launch.js";

const context = {
  actor_id: "local-user",
  actor_binding: "server-owned-session-binding",
  request_id: "request-run-launch-facade"
} as const;

const installed: StudioInstalledRunDefinition = {
  workflowRevision: studioRunValueDigest("workflow-revision"),
  definitionBundleHash: studioRunValueDigest("definition-bundle"),
  config: { message: "installed server configuration" }
};

function routing(...targets: readonly string[]): RouterDefinition {
  return {
    type: "router",
    version: "2026-06",
    rules: targets.map((target, index) => ({
      id: `matching-${index}`,
      when: { expression: "$.invocation.source = 'private'" },
      target: `workflow:${target}` as `workflow:${string}`
    }))
  };
}

function planFor(
  request: StudioRunPlanRequest,
  definition: StudioInstalledRunDefinition = installed,
  overrides: Partial<StudioRunPlan> = {}
): StudioRunPlan {
  return {
    plan_id: `rp_${"p".repeat(32)}`,
    created_at: "2026-07-11T12:00:00.000Z",
    expires_at: "2026-07-11T12:05:00.000Z",
    workflow_id: request.workflow_id,
    mode: "read_only",
    workflow_revision: definition.workflowRevision,
    definition_bundle_hash: definition.definitionBundleHash,
    catalog_fingerprint: studioRunValueDigest("catalog"),
    execution_snapshot_hash: studioRunValueDigest("execution"),
    invocation_hash: studioRunValueDigest(request.invocation),
    config_hash: studioRunValueDigest(request.config),
    repository_required: false,
    input_provenance: request.input_provenance,
    potential_effects: [],
    resolved_effects: [],
    effect_uncertainties: [],
    warnings: [],
    confirmation_required: false,
    confirmation_token: "t".repeat(48),
    ...overrides,
    execution_scope: overrides.execution_scope ?? request.execution_scope
  };
}

describe("StudioRunLaunchFacade", () => {
  it("resolves a private adapter invocation, uses first-match routing, and loads installed config", async () => {
    const privatePayload = { token: "provider-secret", issue: 42 };
    const adapterCalls: unknown[] = [];
    const canonicalRequests: StudioRunPlanRequest[] = [];
    const facade = new StudioRunLaunchFacade({
      adapters: {
        loadPolicy: () => ({ effects: ["network_read"] }),
        resolve: async (adapterId, input, signal) => {
          adapterCalls.push({ adapterId, input, signal });
          return {
            version: "2026-06",
            source: "private",
            event: "task",
            references: { opaque: "provider-reference" },
            payload: privatePayload
          };
        }
      },
      routing: () => routing("first-workflow", "ignored-workflow"),
      routingSimulator: isolatedStudioRoutingSimulationPort,
      installedDefinitions: {
        load: async (workflowId) => {
          expect(workflowId).toBe("first-workflow");
          return installed;
        }
      },
      planner: {
        plan: async (rawRequest) => {
          const request = StudioRunPlanRequestSchema.parse(rawRequest);
          canonicalRequests.push(request);
          return planFor(request);
        }
      }
    });
    const signal = new AbortController().signal;
    const adapterInput = { kind: "cli" as const, value: "opaque://task/42" };
    const plan = await facade.plan({
      kind: "adapter",
      adapter_id: "private-task",
      input: adapterInput,
      acknowledged_effects: ["network_read"]
    }, context, signal);

    expect(adapterCalls).toEqual([{
      adapterId: "private-task",
      input: adapterInput,
      signal
    }]);
    expect(canonicalRequests).toHaveLength(1);
    expect(canonicalRequests[0]).toEqual({
      workflow_id: "first-workflow",
      invocation: {
        version: "2026-06",
        source: "private",
        event: "task",
        references: { opaque: "provider-reference" },
        payload: privatePayload
      },
      config: installed.config,
      execution_scope: { kind: "workflow" },
      input_provenance: {
        kind: "adapter",
        adapter_id: "private-task",
        adapter_input_hash: studioRunValueDigest(adapterInput)
      }
    });
    expect(plan).not.toHaveProperty("invocation");
    expect(plan).not.toHaveProperty("config");
    expect(JSON.stringify(plan)).not.toContain("provider-secret");
    expect(JSON.stringify(plan)).not.toContain("provider-reference");
  });

  it("accepts a normalized invocation without invoking an adapter", async () => {
    let adapterCalled = false;
    let canonical: StudioRunPlanRequest | undefined;
    const facade = new StudioRunLaunchFacade({
      adapters: {
        loadPolicy: () => undefined,
        resolve: async () => {
          adapterCalled = true;
          return undefined;
        }
      },
      routing: () => routing("direct-workflow"),
      routingSimulator: isolatedStudioRoutingSimulationPort,
      installedDefinitions: { load: async () => installed },
      planner: {
        plan: async (rawRequest) => {
          canonical = StudioRunPlanRequestSchema.parse(rawRequest);
          return planFor(canonical);
        }
      }
    });
    await facade.plan({
      kind: "invocation",
      invocation: {
        version: "2026-06",
        source: "private",
        event: "manual",
        payload: { prompt: "server-safe JSON" }
      }
    }, context);

    expect(adapterCalled).toBe(false);
    expect(canonical?.workflow_id).toBe("direct-workflow");
    expect(canonical?.config).toEqual(installed.config);
    expect(canonical?.input_provenance).toEqual({ kind: "invocation" });
  });

  it("performs one bounded decision and only reloads the routing hash for freshness", async () => {
    const definition = routing("first-workflow");
    const loadRouting = vi.fn(() => definition);
    const simulate = vi.fn<StudioRoutingSimulationPort["simulate"]>(
      async () => ({
        status: "matched",
        evaluations: [
          {
            rule_id: "matching-0",
            rule_index: 0,
            expression_path: "$.rules[0].when.expression",
            outcome: "boolean",
            result: true
          }
        ],
        matched_rule: { rule_id: "matching-0", rule_index: 0 },
        target: { type: "workflow", id: "first-workflow" },
        diagnostics: []
      })
    );
    const facade = new StudioRunLaunchFacade({
      adapters: {
        loadPolicy: () => undefined,
        resolve: async () => undefined
      },
      routing: loadRouting,
      routingSimulator: { simulate },
      installedDefinitions: { load: async () => installed },
      planner: {
        plan: async (rawRequest) => {
          const request = StudioRunPlanRequestSchema.parse(rawRequest);
          return planFor(request);
        }
      }
    });
    const caller = new AbortController();

    await facade.plan(
      {
        kind: "invocation",
        invocation: {
          version: "2026-06",
          source: "private",
          event: "manual"
        }
      },
      context,
      caller.signal
    );

    expect(simulate).toHaveBeenCalledOnce();
    expect(simulate.mock.calls[0]?.[0]).toEqual({
      invocation: {
        version: "2026-06",
        source: "private",
        event: "manual"
      }
    });
    expect(simulate.mock.calls[0]?.[1]).toBe(definition);
    expect(simulate.mock.calls[0]?.[2]).toEqual({ signal: caller.signal });
    expect(loadRouting).toHaveBeenCalledTimes(2);
  });

  it("bounds a non-cooperative routing expression before planning", async () => {
    const planner = vi.fn(async () => {
      throw new Error("must not plan");
    });
    const facade = new StudioRunLaunchFacade({
      adapters: {
        loadPolicy: () => undefined,
        resolve: async () => undefined
      },
      routing: () => ({
        type: "router",
        version: "2026-06",
        rules: [
          {
            id: "non-cooperative",
            when: {
              expression: "($loop := function(){ $loop() }; $loop())"
            },
            target: "workflow:never"
          }
        ]
      }),
      routingSimulator: isolatedStudioRoutingSimulationPort,
      installedDefinitions: { load: async () => installed },
      planner: { plan: planner }
    });
    const startedAt = Date.now();

    await expect(
      facade.plan(
        {
          kind: "invocation",
          invocation: {
            version: "2026-06",
            source: "private",
            event: "manual"
          }
        },
        context
      )
    ).rejects.toMatchObject({ code: "studio_run_routing_failed" });

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(planner).not.toHaveBeenCalled();
  });

  it("cancels isolated launch routing with the HTTP lifecycle signal", async () => {
    const planner = vi.fn(async () => {
      throw new Error("must not plan");
    });
    const facade = new StudioRunLaunchFacade({
      adapters: {
        loadPolicy: () => undefined,
        resolve: async () => undefined
      },
      routing: () => ({
        type: "router",
        version: "2026-06",
        rules: [
          {
            id: "non-cooperative",
            when: {
              expression: "($loop := function(){ $loop() }; $loop())"
            },
            target: "workflow:never"
          }
        ]
      }),
      routingSimulator: isolatedStudioRoutingSimulationPort,
      installedDefinitions: { load: async () => installed },
      planner: { plan: planner }
    });
    const caller = new AbortController();
    const outcome = facade.plan(
      {
        kind: "invocation",
        invocation: {
          version: "2026-06",
          source: "private",
          event: "manual"
        }
      },
      context,
      caller.signal
    );
    caller.abort();

    await expect(outcome).rejects.toMatchObject({
      code: "studio_run_routing_failed"
    });
    expect(planner).not.toHaveBeenCalled();
  });

  it("rejects routing no-match and invocation target mismatch", async () => {
    const noMatch = new StudioRunLaunchFacade({
      adapters: {
        loadPolicy: () => undefined,
        resolve: async () => undefined
      },
      routing: () => ({
        type: "router",
        version: "2026-06",
        rules: [{
          id: "never",
          when: { expression: "false" },
          target: "workflow:first-workflow"
        }]
      }),
      routingSimulator: isolatedStudioRoutingSimulationPort,
      installedDefinitions: { load: async () => installed },
      planner: { plan: async () => { throw new Error("must not plan"); } }
    });
    await expect(noMatch.plan({
      kind: "invocation",
      invocation: { version: "2026-06", source: "private", event: "manual" }
    }, context)).rejects.toMatchObject({ code: "studio_run_routing_no_match" });

    const mismatch = new StudioRunLaunchFacade({
      adapters: {
        loadPolicy: () => undefined,
        resolve: async () => undefined
      },
      routing: () => routing("first-workflow"),
      routingSimulator: isolatedStudioRoutingSimulationPort,
      installedDefinitions: { load: async () => installed },
      planner: { plan: async () => { throw new Error("must not plan"); } }
    });
    await expect(mismatch.plan({
      kind: "invocation",
      invocation: {
        version: "2026-06",
        source: "private",
        event: "manual",
        target: { type: "workflow", id: "different-workflow" }
      }
    }, context)).rejects.toMatchObject({ code: "studio_run_target_mismatch" });
  });

  it("rejects a plan when installed config or routing changes during planning", async () => {
    let routingCall = 0;
    const facade = new StudioRunLaunchFacade({
      adapters: {
        loadPolicy: () => undefined,
        resolve: async () => undefined
      },
      routing: () => {
        routingCall += 1;
        return routingCall === 1
          ? routing("first-workflow")
          : routing("changed-workflow");
      },
      routingSimulator: isolatedStudioRoutingSimulationPort,
      installedDefinitions: { load: async () => installed },
      planner: {
        plan: async (rawRequest) => {
          const request = StudioRunPlanRequestSchema.parse(rawRequest);
          return planFor(request, installed, {
            definition_bundle_hash: studioRunValueDigest("changed-config-bundle")
          });
        }
      }
    });

    await expect(facade.plan({
      kind: "invocation",
      invocation: { version: "2026-06", source: "private", event: "manual" }
    }, context)).rejects.toMatchObject({ code: "studio_run_plan_stale" });
  });

  it("sanitizes unknown, failed, and invalid adapter resolution", async () => {
    const base = {
      routing: () => routing("first-workflow"),
      routingSimulator: isolatedStudioRoutingSimulationPort,
      installedDefinitions: { load: async () => installed },
      planner: { plan: async () => { throw new Error("must not plan"); } }
    };
    const input = {
      kind: "adapter" as const,
      adapter_id: "private-task",
      input: { kind: "cli" as const, value: "secret-input" },
      acknowledged_effects: []
    };
    await expect(new StudioRunLaunchFacade({
      ...base,
      adapters: {
        loadPolicy: () => undefined,
        resolve: async () => undefined
      }
    }).plan(input, context)).rejects.toMatchObject({
      code: "studio_run_adapter_unknown"
    });
    const failed = await new StudioRunLaunchFacade({
      ...base,
      adapters: {
        loadPolicy: () => ({ effects: [] }),
        resolve: async () => { throw new Error("unsafe provider secret"); }
      }
    }).plan(input, context).catch((error: unknown) => error);
    expect(failed).toMatchObject({ code: "studio_run_adapter_failed" });
    expect((failed as Error).message).not.toContain("unsafe provider secret");
    await expect(new StudioRunLaunchFacade({
      ...base,
      adapters: {
        loadPolicy: () => ({ effects: [] }),
        resolve: async () => ({
          version: "2026-06",
          source: "private",
          event: "task",
          references: { tooLarge: "x".repeat(1_100_000) }
        })
      }
    }).plan(input, context)).rejects.toMatchObject({
      code: "studio_run_adapter_failed"
    });
  });

  it("does not load an adapter before its exact effects are acknowledged", async () => {
    let resolved = false;
    const facade = new StudioRunLaunchFacade({
      adapters: {
        loadPolicy: () => ({ effects: ["credential_read", "network_read"] }),
        resolve: async () => {
          resolved = true;
          throw new Error("must not load");
        }
      },
      routing: () => routing("first-workflow"),
      routingSimulator: isolatedStudioRoutingSimulationPort,
      installedDefinitions: { load: async () => installed },
      planner: { plan: async () => { throw new Error("must not plan"); } }
    });

    await expect(facade.plan({
      kind: "adapter",
      adapter_id: "private-task",
      input: { kind: "cli", value: "opaque" },
      acknowledged_effects: ["network_read"]
    }, context)).rejects.toMatchObject({
      code: "studio_run_adapter_effects_unacknowledged"
    });
    expect(resolved).toBe(false);
  });
});
