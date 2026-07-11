import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineInputAdapters } from "../../../src/adapters/registry.js";
import type { RegisteredInputAdapter } from "../../../src/adapters/types.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { MemoryStudioRunConfirmations } from "../../../src/studio/adapters/memory/run-confirmations.js";
import { NativeStudioRunLaunchInput } from "../../../src/studio/adapters/native/run-launch-input.js";
import { NativeStudioRunPlanResolver } from "../../../src/studio/adapters/native/run-plan-resolver.js";
import { StudioRunLaunchService } from "../../../src/studio/application/runs/launch-service.js";
import { StudioRunLaunchFacade } from "../../../src/studio/application/runs/launch-facade.js";
import { isolatedStudioRoutingSimulationPort } from "../../../src/studio/application/routing/routing-simulator.js";
import { studioRunValueDigest } from "../../../src/studio/application/runs/launch-digests.js";
import {
  BASE_TIME,
  cleanupNativeLaunchFixtures,
  executeRequest,
  interruptibleWorkflowSource,
  launchContext,
  launchService,
  policyBearingAgentAndPatternSource,
  request,
  writeFixture,
  type NativeFixture
} from "./native-run-launch-test-support.js";

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});

describe("native Studio run planning", () => {
  it("rejects an unknown agent model profile during planning before dispatch", async () => {
    const fixture = await writeFixture();
    await appendFile(
      path.join(fixture.projectRoot, "agents", "pinned-agent", "agent.yaml"),
      "\n# replace the configured profile below\n"
    );
    const agentPath = path.join(
      fixture.projectRoot,
      "agents",
      "pinned-agent",
      "agent.yaml"
    );
    const agentSource = await readFile(agentPath, "utf8");
    await writeFile(
      agentPath,
      agentSource.replace("model_profile: fast", "model_profile: missing")
    );
    let dispatches = 0;

    await expect(launchService(fixture, {
      dispatch: async () => {
        dispatches += 1;
        throw new Error("invalid model profiles must not dispatch");
      }
    }).plan(request, launchContext)).rejects.toMatchObject({
      code: "studio_run_plan_resolution_invalid"
    });
    expect(dispatches).toBe(0);
  });

  it("fails closed when a read-only agent declares an MCP server", async () => {
    const fixture = await writeFixture();
    await appendFile(
      path.join(
        fixture.projectRoot,
        "agents",
        "pinned-agent",
        "agent.yaml"
      ),
      "mcp_servers:\n  - arbitrary-mcp\n"
    );
    const plan = await launchService(fixture, {
      dispatch: async () => {
        throw new Error("planning must not dispatch");
      }
    }).plan(request, launchContext);

    expect(plan.mode).toBe("read_only");
    expect(plan.confirmation_required).toBe(true);
    expect(plan.effect_uncertainties).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "dynamic_agent_tools",
        node_id: "analyze",
        may_include_unlisted_write: true
      })
    ]));
  });

  it("keeps a read-only local tool safe only when its contract denies all side effects", async () => {
    const fixture = await writeFixture();
    await appendFile(
      path.join(
        fixture.projectRoot,
        "agents",
        "pinned-agent",
        "agent.yaml"
      ),
      "tools:\n  - repository.read-file\n"
    );
    const plan = await launchService(fixture, {
      dispatch: async () => {
        throw new Error("planning must not dispatch");
      }
    }).plan(request, launchContext);

    expect(plan.confirmation_required).toBe(false);
    expect(plan.effect_uncertainties).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "dynamic_agent_tools",
        node_id: "analyze",
        may_include_unlisted_write: false
      })
    ]));
  });

  it("requires confirmation for write policies declared by agent and pattern nodes", async () => {
    const fixture = await writeFixture();
    await writeFile(
      fixture.workflowPath,
      policyBearingAgentAndPatternSource(fixture)
    );
    const service = launchService(fixture, {
      dispatch: async () => {
        throw new Error("planning must not dispatch");
      }
    });

    const plan = await service.plan(request, launchContext);

    expect(plan.mode).toBe("read_only");
    expect(plan.confirmation_required).toBe(true);
    expect(plan.potential_effects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node_id: "analyze",
        registration_id: "pinned-agent",
        policy_id: "change-request.create_side_effect",
        operation_id: "change-request.create",
        category: "external_write",
        confirmation_required: true
      }),
      expect.objectContaining({
        node_id: "policy-pattern",
        registration_id: "quality-gates.gated_agent_loop",
        policy_id: "change-request.create_side_effect",
        operation_id: "change-request.create",
        category: "external_write",
        confirmation_required: true
      })
    ]));
  });

  it("plans only the selected node and its ancestors for a partial execution", async () => {
    const fixture = await writeFixture();
    await writeFile(
      fixture.workflowPath,
      policyBearingAgentAndPatternSource(fixture)
    );
    const partialRequest = {
      ...request,
      execution_scope: { kind: "through_node" as const, node_id: "analyze" }
    };

    const plan = await launchService(fixture, {
      dispatch: async () => {
        throw new Error("planning must not dispatch");
      }
    }).plan(partialRequest, launchContext);

    expect(plan.execution_scope).toEqual(partialRequest.execution_scope);
    expect(plan.potential_effects.length).toBeGreaterThan(0);
    expect(plan.potential_effects.every((effect) => effect.node_id === "analyze"))
      .toBe(true);
    expect(plan.potential_effects).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ node_id: "policy-pattern" })
    ]));
  });

  it("rejects a partial execution target that is not in the workflow", async () => {
    const fixture = await writeFixture();
    await expect(launchService(fixture, {
      dispatch: async () => {
        throw new Error("invalid scopes must not dispatch");
      }
    }).plan({
      ...request,
      execution_scope: { kind: "through_node", node_id: "missing" }
    }, launchContext)).rejects.toMatchObject({
      code: "studio_run_plan_resolution_invalid",
      details: { node_id: "missing" }
    });
  });

  it("blocks planning and execute revalidation when the compiled DAG can interrupt", async () => {
    const fixture = await writeFixture();
    let dispatches = 0;
    const service = launchService(fixture, {
      dispatch: async () => {
        dispatches += 1;
        throw new Error("interruptible workflows must not reach dispatch");
      }
    });
    const initialPlan = await service.plan(request, launchContext);
    await writeFile(
      fixture.workflowPath,
      interruptibleWorkflowSource(fixture)
    );

    await expect(service.execute(
      initialPlan.plan_id,
      executeRequest(initialPlan.confirmation_token),
      launchContext
    )).rejects.toMatchObject({
      code: "studio_run_interrupt_resume_unsupported",
      details: {
        workflow_id: "pinned-workflow",
        mode: "read_only",
        interruptible_node_count: 1
      }
    });
    await expect(launchService(fixture, {
      dispatch: async () => {
        dispatches += 1;
        throw new Error("planning must not dispatch");
      }
    }).plan(request, launchContext)).rejects.toMatchObject({
      code: "studio_run_interrupt_resume_unsupported"
    });
    expect(dispatches).toBe(0);
  });

  it.each([
    ["workflow", (fixture: NativeFixture) => fixture.workflowPath],
    ["agent", (fixture: NativeFixture) => fixture.agentInstructionsPath],
    ["config", (fixture: NativeFixture) => fixture.runtimeConfigPath],
    ["routing", (fixture: NativeFixture) => fixture.routingPath]
  ] as const)(
    "rejects a plan when the pinned %s definition changes before acceptance",
    async (_kind, changedPath) => {
      const fixture = await writeFixture();
      let dispatches = 0;
      const service = launchService(fixture, {
        dispatch: async () => {
          dispatches += 1;
          throw new Error("stale plans must not reach dispatch");
        }
      });
      const plan = await service.plan(request, launchContext);
      await appendFile(changedPath(fixture), "\n# changed after planning\n");

      await expect(service.execute(
        plan.plan_id,
        executeRequest(plan.confirmation_token),
        launchContext
      )).rejects.toMatchObject({ code: "studio_run_plan_stale" });
      expect(dispatches).toBe(0);
    }
  );

  it("resolves a registered adapter and real installed config without exposing private input", async () => {
    const fixture = await writeFixture();
    const adapterCalls: unknown[] = [];
    const privateAdapter: RegisteredInputAdapter = {
      id: "private-task",
      description: "Private task adapter",
      source: "studio",
      loadEffects: [],
      load: async (input, context) => {
        adapterCalls.push({
          input,
          projectRoot: context.projectRoot,
          configRoot: context.configRoot
        });
        return {
          version: "2026-06" as const,
          source: "studio",
          event: "private_task",
          references: { provider: "private-reference" },
          payload: { token: "private-provider-token" }
        };
      }
    };
    const registry = defineInputAdapters([privateAdapter]);
    const platform = {
      ...nativeLunaPlatformRegistrations,
      inputAdapterRegistry: registry
    };
    const canonical = new StudioRunLaunchService({
      resolver: new NativeStudioRunPlanResolver({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        platform
      }),
      confirmations: new MemoryStudioRunConfirmations({ now: () => BASE_TIME }),
      dispatcher: {
        dispatch: async () => {
          throw new Error("planning must not dispatch");
        }
      },
      now: () => BASE_TIME,
      createPlanId: () => `rp_${"i".repeat(32)}`
    });
    const nativeInput = new NativeStudioRunLaunchInput({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      platform
    });
    const facade = new StudioRunLaunchFacade({
      planner: canonical,
      adapters: nativeInput,
      routing: () => ({
        type: "router",
        version: "2026-06",
        rules: [{
          id: "private-task",
          when: { expression: "$.invocation.event = 'private_task'" },
          target: "workflow:pinned-workflow"
        }]
      }),
      routingSimulator: isolatedStudioRoutingSimulationPort,
      installedDefinitions: nativeInput
    });
    const adapterInput = {
      kind: "cli" as const,
      value: "opaque://private-task?secret=must-not-leak"
    };
    const plan = await facade.plan({
      kind: "adapter",
      adapter_id: "private-task",
      input: adapterInput,
      acknowledged_effects: []
    }, launchContext);

    expect(adapterCalls).toEqual([{
      input: adapterInput,
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot
    }]);
    expect(plan.workflow_id).toBe("pinned-workflow");
    expect(plan.mode).toBe("read_only");
    expect(plan.config_hash).toBe(studioRunValueDigest({
      message: "file default that must not override the request"
    }));
    expect(plan.input_provenance).toEqual({
      kind: "adapter",
      adapter_id: "private-task",
      adapter_input_hash: studioRunValueDigest(adapterInput)
    });
    expect(JSON.stringify(plan)).not.toContain("must-not-leak");
    expect(JSON.stringify(plan)).not.toContain("private-provider-token");
    expect(JSON.stringify(plan)).not.toContain("private-reference");
  });

  it("rejects a native façade plan when installed config changes before snapshot acceptance", async () => {
    const fixture = await writeFixture();
    const noInputAdapters: readonly RegisteredInputAdapter[] = [];
    const platform = {
      ...nativeLunaPlatformRegistrations,
      inputAdapterRegistry: defineInputAdapters(noInputAdapters)
    };
    const canonical = new StudioRunLaunchService({
      resolver: new NativeStudioRunPlanResolver({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        platform
      }),
      confirmations: new MemoryStudioRunConfirmations({ now: () => BASE_TIME }),
      dispatcher: {
        dispatch: async () => {
          throw new Error("planning must not dispatch");
        }
      },
      now: () => BASE_TIME,
      createPlanId: () => `rp_${"s".repeat(32)}`
    });
    const nativeInput = new NativeStudioRunLaunchInput({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      platform
    });
    const facade = new StudioRunLaunchFacade({
      planner: {
        plan: async (input, context) => {
          await writeFile(
            fixture.runtimeConfigPath,
            "message: configuration changed during planning\n"
          );
          return await canonical.plan(input, context);
        }
      },
      adapters: nativeInput,
      routing: () => ({
        type: "router",
        version: "2026-06",
        rules: [{
          id: "manual",
          when: { expression: "true" },
          target: "workflow:pinned-workflow"
        }]
      }),
      routingSimulator: isolatedStudioRoutingSimulationPort,
      installedDefinitions: nativeInput
    });

    await expect(facade.plan({
      kind: "invocation",
      invocation: {
        version: "2026-06",
        source: "studio",
        event: "manual"
      }
    }, launchContext)).rejects.toMatchObject({ code: "studio_run_plan_stale" });
  });
});
