import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineInputAdapters } from "../../../src/adapters/registry.js";
import type { RegisteredInputAdapter } from "../../../src/adapters/types.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { validatePrecompletedSteps } from "../../../src/runtime/workflow/precompleted-steps.js";
import { StudioRunOutputFixtureService } from "../../../src/studio/application/drafts/run-output-fixture-service.js";
import { StudioDraftTestDataService } from "../../../src/studio/application/drafts/manual-test-data-service.js";
import { nativePrecompletedSteps } from "../../../src/studio/adapters/native/run-execution-profile.js";
import { sha256Digest } from "../../../src/core/workflow/definition-digests.js";
import { RunRecordSchema } from "../../../src/studio/contracts/runs.js";
import type { JsonValue } from "../../../src/core/json/value.js";
import type { StudioRunExecutionProfile } from "../../../src/studio/contracts/manual-test-data.js";
import { MemoryStudioRunConfirmations } from "../../../src/studio/adapters/memory/run-confirmations.js";
import { NativeStudioRunLaunchInput } from "../../../src/studio/adapters/native/run-launch-input.js";
import { NativeStudioRunDefinitionSource } from "../../../src/studio/adapters/native/run-definition-source.js";
import { NativeStudioRunPlanResolver } from "../../../src/studio/adapters/native/run-plan-resolver.js";
import { StudioRunLaunchService } from "../../../src/studio/application/runs/launch-service.js";
import { StudioRunLaunchFacade } from "../../../src/studio/application/runs/launch-facade.js";
import { isolatedStudioRoutingSimulationPort } from "../../../src/studio/application/routing/routing-simulator.js";
import { studioRunValueDigest } from "../../../src/studio/application/runs/launch-digests.js";
import type { StudioDraftItem } from "../../../src/studio/contracts/draft-authoring.js";
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

function manualTestData(nodeId: string) {
  const output = { supplied: nodeId };
  const outputHash = studioRunValueDigest(output);
  return {
    kind: "draft_fixture" as const,
    fixture_name: `fixture-${nodeId}`,
    node_id: nodeId,
    output,
    output_hash: outputHash,
    source: {
      kind: "run_node_output" as const,
      run_id: `source-${nodeId}`,
      workflow_id: request.workflow_id,
      node_id: nodeId,
      graph_hash: outputHash,
      outcome_hash: outputHash,
      workflow_revision: outputHash,
      definition_bundle_hash: outputHash,
      captured_at: "2026-07-11T11:00:00.000Z",
      redaction_changed: false,
      definition_source: { kind: "installed" as const }
    }
  };
}

describe("native Studio run planning", () => {
  it("edits, authorizes, plans, dispatches, and validates an edited draft cutpoint", async () => {
    const fixture = await writeFixture();
    const draftId = "40e67383-a2ce-4c41-93f5-23fc5354ba29";
    let etag = "draft-edit-source";
    const workflowDirectory = path.dirname(fixture.workflowPath);
    const file = async (name: string, media_type: "application/json" | "application/yaml") => ({
      file: { root: "project" as const, path: `workflows/pinned-workflow/${name}` },
      media_type,
      state: "present" as const,
      content: name === "workflow.yaml"
        ? fixture.workflowSource
        : await readFile(path.join(workflowDirectory, name), "utf8")
    });
    let current: StudioDraftItem = {
      draft_id: draftId,
      record_revision: 1,
      content_revision: 1,
      layout_revision: 0,
      primary_resource: { kind: "workflow", id: "pinned-workflow" },
      status: "valid",
      draft_hash: studioRunValueDigest(fixture.workflowSource),
      etag,
      files: await Promise.all([
        file("workflow.yaml", "application/yaml"),
        file("input.schema.json", "application/json"),
        file("output.schema.json", "application/json"),
        file("config.schema.json", "application/json")
      ]),
      layout: {},
      created_at: "2026-07-11T12:00:00.000Z",
      updated_at: "2026-07-11T12:00:00.000Z"
    };
    const drafts = {
      get: async () => current,
      patch: async (_id: string, input: { readonly layout?: unknown }) => {
        etag = `draft-edit-${current.record_revision + 1}`;
        current = {
          ...current,
          record_revision: current.record_revision + 1,
          layout_revision: current.layout_revision + 1,
          etag,
          ...(input.layout === undefined ? {} : { layout: input.layout as JsonValue })
        };
        return current;
      }
    };
    const platform = {
      ...nativeLunaPlatformRegistrations,
      inputAdapterRegistry: defineInputAdapters([])
    };
    const definitions = new NativeStudioRunDefinitionSource({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      platform,
      drafts
    });
    const definition = await definitions.loadDraft({
      kind: "draft",
      draft_id: draftId,
      etag
    });
    const original = { supplied: "original" };
    const edited = { supplied: "edited" };
    const graphHash = sha256Digest({ graph: 1 });
    const outcomeHash = sha256Digest({ outcome: 1 });
    const capturedAt = "2026-07-11T12:00:01.000Z";
    const sourceRecord = RunRecordSchema.parse({
      schema_version: 1,
      record_revision: 1,
      run_id: "source-edited-cutpoint",
      workflow_id: "pinned-workflow",
      definition_source: { kind: "draft", draft_id: draftId, etag },
      workflow_revision: definition.workflowRevision,
      definition_bundle_hash: definition.definitionBundleHash,
      catalog_fingerprint: sha256Digest("catalog"),
      execution_snapshot_hash: sha256Digest("execution"),
      dispatch_status: "started",
      run_status: "succeeded",
      created_at: capturedAt,
      updated_at: capturedAt,
      started_at: capturedAt,
      finished_at: capturedAt,
      owner_id: "source-worker",
      owner_claimed_at: capturedAt,
      heartbeat_at: capturedAt,
      active_node_ids: [],
      artifact_count: 0,
      interrupt_count: 0,
      side_effects: [],
      completeness: "complete"
    });
    const outputs = {
      getWithRecord: async () => ({
        response: {
          schema_version: 1 as const,
          availability: "available" as const,
          run: {
            run_id: sourceRecord.run_id,
            workflow_id: sourceRecord.workflow_id,
            workflow_revision: definition.workflowRevision,
            definition_bundle_hash: definition.definitionBundleHash,
            execution_snapshot_hash: sourceRecord.execution_snapshot_hash,
            status: "succeeded" as const,
            completeness: "complete" as const
          },
          node_id: "analyze",
          graph_hash: graphHash,
          outcome_hash: outcomeHash,
          output: {
            availability: "available" as const,
            value: original,
            redaction: { mode: "best_effort" as const, changed: false }
          }
        },
        record: sourceRecord
      })
    };
    const fixtures = new StudioRunOutputFixtureService({
      drafts,
      outputs,
      validator: definitions
    });
    await fixtures.promote(draftId, {
      fixture_name: "edited-cutpoint",
      run_id: sourceRecord.run_id,
      node_id: "analyze",
      graph_hash: graphHash,
      outcome_hash: outcomeHash
    }, etag);
    await fixtures.edit(draftId, {
      fixture_name: "edited-cutpoint",
      output: edited
    }, etag);

    let dispatchedPlanId: string | undefined;
    let commandExecutionProfile: StudioRunExecutionProfile | undefined;
    const canonical = new StudioRunLaunchService({
      resolver: new NativeStudioRunPlanResolver({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        platform,
        definitions
      }),
      confirmations: new MemoryStudioRunConfirmations({ now: () => BASE_TIME }),
      dispatcher: {
        dispatch: async (command) => {
          dispatchedPlanId = command.planId;
          commandExecutionProfile = command.request.execution_profile;
          return {
            accepted: true as const,
            dispatch_status: "queued" as const,
            run_id: "edited-cutpoint-run",
            plan_id: command.planId,
            execution_snapshot_hash: command.snapshot.execution_snapshot_hash,
            accepted_at: command.requestedAt
          };
        }
      },
      now: () => BASE_TIME,
      createPlanId: () => `rp_${"e".repeat(32)}`
    });
    const facade = new StudioRunLaunchFacade({
      planner: canonical,
      adapters: new NativeStudioRunLaunchInput({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        platform
      }),
      routing: () => { throw new Error("draft test bypasses routing"); },
      routingSimulator: isolatedStudioRoutingSimulationPort,
      installedDefinitions: definitions,
      draftDefinitions: definitions,
      draftTestData: new StudioDraftTestDataService({ drafts, definitions, outputs })
    });
    const plan = await facade.planDraftTest(draftId, {
      input: {
        kind: "invocation",
        definition_source: { kind: "draft", draft_id: draftId, etag },
        execution_scope: { kind: "workflow" },
        invocation: {
          version: "2026-06",
          source: "studio",
          event: "manual",
          target: { type: "workflow", id: "pinned-workflow" },
          payload: {}
        }
      },
      test_data: [{ fixture_name: "edited-cutpoint" }]
    }, launchContext);
    await canonical.execute(
      plan.plan_id,
      executeRequest(plan.confirmation_token),
      launchContext
    );

    expect(dispatchedPlanId).toBe(plan.plan_id);
    if (commandExecutionProfile === undefined) {
      throw new Error("dispatch must retain the authorized execution profile");
    }
    const precompleted = nativePrecompletedSteps(commandExecutionProfile);
    expect(precompleted).toEqual({ analyze: edited });
    expect(validatePrecompletedSteps({
      workflow_id: "pinned-workflow",
      workflow_revision: definition.workflowRevision,
      state_schema_version: "1",
      nodes: [{
        id: "analyze",
        kind: "agent",
        yaml_path: "$.nodes[0]",
        capability_id: "pinned-agent",
        output_schema: { type: "object" },
        can_create_pending_interrupt: false,
        source: { id: "analyze", type: "agent", agent: "pinned-agent", output_schema: "output.schema.json" }
      }],
      edges: [],
      state: { channels: {} }
    }, precompleted)).toEqual({ analyze: edited });
  });

  it("accepts overlapping selected fixtures but activates only the downstream cutpoint", async () => {
    const fixture = await writeFixture();
    await writeFile(
      fixture.workflowPath,
      fixture.workflowSource.replace(
        "    input:\n      invocation:\n        expression: $.invocation\n",
        [
          "    input:",
          "      invocation:",
          "        expression: $.invocation",
          "  - id: summarize",
          "    type: agent",
          "    agent: pinned-agent",
          "    output_schema: output.schema.json",
          "    after: [analyze]",
          "    input:",
          "      analysis:",
          "        expression: $.steps.analyze",
          ""
        ].join("\n")
      )
    );
    const service = launchService(fixture, {
      dispatch: async () => { throw new Error("must not dispatch"); }
    });

    const plan = await service.plan({
      ...request,
      execution_profile: {
        kind: "manual_test",
        test_data: [manualTestData("analyze"), manualTestData("summarize")]
      }
    }, launchContext);

    expect(plan.execution_profile).toMatchObject({
      kind: "manual_test",
      test_data: [
        { node_id: "analyze" },
        { node_id: "summarize" }
      ]
    });
  });

  it("rejects a manual-test node outside the source workflow", async () => {
    const fixture = await writeFixture();
    const service = launchService(fixture, {
      dispatch: async () => { throw new Error("must not dispatch"); }
    });

    await expect(service.plan({
      ...request,
      execution_profile: {
        kind: "manual_test",
        test_data: [manualTestData("missing")]
      }
    }, launchContext)).rejects.toMatchObject({
      code: "studio_run_test_data_stale",
      details: { node_id: "missing" }
    });
  });

  it("plans a brand-new saved workflow draft before it is installed", async () => {
    const fixture = await writeFixture();
    const workflowId = "new-draft-workflow";
    const workflowSource = fixture.workflowSource.replace(
      "id: pinned-workflow",
      `id: ${workflowId}`
    );
    const workflowDirectory = path.dirname(fixture.workflowPath);
    const draftId = "40e67383-a2ce-4c41-93f5-23fc5354ba28";
    const etag = "saved-new-workflow-etag";
    const file = async (name: string, media_type: "application/json" | "application/yaml") => ({
      file: { root: "project" as const, path: `workflows/${workflowId}/${name}` },
      media_type,
      state: "present" as const,
      content: name === "workflow.yaml"
        ? workflowSource
        : await readFile(path.join(workflowDirectory, name), "utf8")
    });
    const draft: StudioDraftItem = {
      draft_id: draftId,
      record_revision: 1,
      content_revision: 1,
      layout_revision: 0,
      primary_resource: { kind: "workflow", id: workflowId },
      status: "valid",
      draft_hash: studioRunValueDigest(workflowSource),
      etag,
      files: await Promise.all([
        file("workflow.yaml", "application/yaml"),
        file("input.schema.json", "application/json"),
        file("output.schema.json", "application/json"),
        file("config.schema.json", "application/json")
      ]),
      created_at: "2026-07-11T12:00:00.000Z",
      updated_at: "2026-07-11T12:00:00.000Z"
    };
    const platform = {
      ...nativeLunaPlatformRegistrations,
      inputAdapterRegistry: defineInputAdapters([])
    };
    const definitions = new NativeStudioRunDefinitionSource({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      platform,
      drafts: { get: async (requestedId) => {
        expect(requestedId).toBe(draftId);
        return draft;
      } }
    });
    const canonical = new StudioRunLaunchService({
      resolver: new NativeStudioRunPlanResolver({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        platform,
        definitions
      }),
      confirmations: new MemoryStudioRunConfirmations({ now: () => BASE_TIME }),
      dispatcher: { dispatch: async () => { throw new Error("must not dispatch"); } },
      now: () => BASE_TIME,
      createPlanId: () => `rp_${"d".repeat(32)}`
    });
    const facade = new StudioRunLaunchFacade({
      planner: canonical,
      adapters: new NativeStudioRunLaunchInput({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        platform
      }),
      routing: () => { throw new Error("draft execution must bypass routing"); },
      routingSimulator: isolatedStudioRoutingSimulationPort,
      installedDefinitions: definitions,
      draftDefinitions: definitions
    });

    const plan = await facade.plan({
      kind: "invocation",
      definition_source: { kind: "draft", draft_id: draftId, etag },
      invocation: {
        version: "2026-06",
        source: "studio",
        event: "manual",
        target: { type: "workflow", id: workflowId },
        payload: {}
      }
    }, launchContext);

    expect(plan.workflow_id).toBe(workflowId);
    expect(plan.definition_source).toEqual({ kind: "draft", draft_id: draftId, etag });
    expect(plan.definition_bundle_hash).not.toBe("");
  });

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

  it("reports an invalid saved workflow as a plan conflict instead of an internal failure", async () => {
    const fixture = await writeFixture();
    await writeFile(
      fixture.workflowPath,
      fixture.workflowSource.replace("    type: agent", "    type: unsupported")
    );

    await expect(launchService(fixture, {
      dispatch: async () => {
        throw new Error("invalid definitions must not dispatch");
      }
    }).plan(request, launchContext)).rejects.toMatchObject({
      code: "studio_run_plan_resolution_invalid"
    });
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

  it("plans interruptible workflows while keeping stale-plan revalidation", async () => {
    const fixture = await writeFixture();
    let dispatches = 0;
    const service = launchService(fixture, {
      dispatch: async () => {
        dispatches += 1;
        throw new Error("the stale plan must not reach dispatch");
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
    )).rejects.toMatchObject({ code: "studio_run_plan_stale" });
    const interruptiblePlan = await launchService(fixture, {
      dispatch: async () => {
        dispatches += 1;
        throw new Error("planning must not dispatch");
      }
    }).plan(request, launchContext);
    expect(interruptiblePlan.workflow_id).toBe("pinned-workflow");
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

  it("rejects a plan when a pinned external agent skill changes", async () => {
    const fixture = await writeFixture();
    const skillPath = path.join(
      fixture.projectRoot,
      "skills",
      "pinned-safe",
      "SKILL.md"
    );
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, [
      "---",
      "name: pinned-safe",
      "description: Pinned safety guidance.",
      "---",
      "",
      "Keep the original guidance.",
      ""
    ].join("\n"));
    await appendFile(
      path.join(fixture.projectRoot, "agents", "pinned-agent", "agent.yaml"),
      "skills:\n  - ../../skills/pinned-safe/SKILL.md\n"
    );
    let dispatches = 0;
    const service = launchService(fixture, {
      dispatch: async () => {
        dispatches += 1;
        throw new Error("stale plans must not reach dispatch");
      }
    });
    const plan = await service.plan(request, launchContext);
    await appendFile(skillPath, "\nChanged after planning.\n");

    await expect(service.execute(
      plan.plan_id,
      executeRequest(plan.confirmation_token),
      launchContext
    )).rejects.toMatchObject({ code: "studio_run_plan_stale" });
    expect(dispatches).toBe(0);
  });

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
    const definitions = new NativeStudioRunDefinitionSource({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      platform,
      drafts: { get: async () => { throw new Error("drafts are not used"); } }
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
      installedDefinitions: definitions
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
    const definitions = new NativeStudioRunDefinitionSource({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      platform,
      drafts: { get: async () => { throw new Error("drafts are not used"); } }
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
      installedDefinitions: definitions
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
