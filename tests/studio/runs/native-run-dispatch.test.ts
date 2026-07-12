import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeWorkflowRunInput } from "../../../src/runtime/composition/target-executor.js";
import { createInitialRuntimeState } from "../../../src/core/runtime/state.js";
import { assertCheckpointJsonValue } from "../../../src/core/runtime/json.js";
import { loadNativeRunContext } from "../../../src/platform/native/native-run-context.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { NativeStudioRunDispatchQueue } from "../../../src/studio/adapters/filesystem/run-dispatch-queue.js";
import { NativeStudioRunRecoveryJournal } from "../../../src/studio/adapters/filesystem/run-recovery-journal.js";
import { FilesystemRunGraphStore } from "../../../src/studio/adapters/filesystem/run-graph-store.js";
import { NativeStudioRunDispatcher } from "../../../src/studio/adapters/native/run-dispatcher.js";
import { createSqliteRunStore } from "../../../src/studio/adapters/sqlite/run-store.js";
import { CheckpointWriteAcceptanceUnknownError } from "../../../src/runtime/workflow/checkpoints.js";
import { studioRunValueDigest } from "../../../src/studio/application/runs/launch-digests.js";
import type { RunLedgerPort } from "../../../src/studio/application/runs/ports.js";
import type { RunGraphSnapshotStorePort } from "../../../src/studio/application/runs/graph-snapshot.js";
import {
  BASE_TIME,
  captureCommand,
  cleanupNativeLaunchFixtures,
  executeRequest,
  failedResult,
  launchContext,
  launchService,
  request,
  successfulResult,
  policyBearingAgentAndPatternSource,
  replaySafeBuiltInWorkflowSource,
  waitForRun,
  writeFixture
} from "./native-run-launch-test-support.js";

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});

describe("native Studio run dispatch", () => {
  it("passes multiple authorized outputs to the native runtime in canonical node order", async () => {
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
          "    input:",
          "      invocation:",
          "        expression: $.invocation",
          ""
        ].join("\n")
      )
    );
    const output = { verdict: "supplied-by-test" };
    const summaryOutput = { summary: "also-supplied" };
    const digest = studioRunValueDigest(output);
    const summaryDigest = studioRunValueDigest(summaryOutput);
    const testData = (
      nodeId: "analyze" | "summarize",
      fixtureName: string,
      value: Record<string, string>,
      valueDigest: string
    ) => ({
      kind: "draft_fixture" as const,
      fixture_name: fixtureName,
      node_id: nodeId,
      output: value,
      output_hash: valueDigest,
      source: {
        kind: "run_node_output" as const,
        run_id: `source-run-${nodeId}`,
        workflow_id: "pinned-workflow",
        node_id: nodeId,
        graph_hash: valueDigest,
        outcome_hash: valueDigest,
        workflow_revision: valueDigest,
        definition_bundle_hash: valueDigest,
        captured_at: "2026-07-11T11:00:00.000Z",
        redaction_changed: false,
        definition_source: { kind: "installed" as const }
      }
    });
    const manualRequest = {
      ...request,
      execution_profile: {
        kind: "manual_test" as const,
        test_data: [
          testData("summarize", "saved-summary-output", summaryOutput, summaryDigest),
          testData("analyze", "saved-analyze-output", output, digest)
        ]
      }
    };
    const { command } = await captureCommand(fixture, { request: manualRequest });
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    let runtimeInput: NativeWorkflowRunInput | undefined;
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "manual-test-worker",
      schedule: (task) => scheduled.push(task),
      runWorkflow: async (input) => {
        runtimeInput = input;
        const context = await loadNativeRunContext(input, {
          platform: nativeLunaPlatformRegistrations
        });
        await input.onCompiledWorkflow?.(context.nativeWorkflow.compiled);
        if (input.run === undefined) throw new Error("preallocated run required");
        const invocation = input.invocation;
        const config = input.workflowConfig ?? {};
        assertCheckpointJsonValue(invocation);
        assertCheckpointJsonValue(config);
        const state = {
          ...createInitialRuntimeState({
            invocation,
            config,
            run: input.run,
            workflow: { id: "pinned-workflow", mode: "read_only" }
          }),
          steps: { analyze: output, summarize: summaryOutput },
          run_status: "succeeded" as const
        };
        await input.onSucceededState?.(state);
        return { status: "succeeded" as const, output, state };
      }
    });
    try {
      await dispatcher.initialize();
      const receipt = await dispatcher.dispatch(command);
      scheduled.splice(0).forEach((task) => task());
      await waitForRun(store.ledger, receipt.run_id, "succeeded");
      expect(runtimeInput?.precompleted_steps).toEqual({
        analyze: output,
        summarize: summaryOutput
      });
      expect(command.snapshot.execution_profile).toMatchObject({
        kind: "manual_test",
        test_data: [
          { node_id: "analyze", fixture_name: "saved-analyze-output" },
          { node_id: "summarize", fixture_name: "saved-summary-output" }
        ]
      });
      await expect(store.ledger.get(receipt.run_id)).resolves.toMatchObject({
        execution_profile: command.snapshot.execution_profile,
        execution_profile_hash: command.snapshot.execution_profile_hash
      });
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("is idempotent and executes only the exact accepted immutable snapshot", async () => {
    const fixture = await writeFixture();
    const { command, confirmationToken } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    const backgroundErrors: unknown[] = [];
    const runInputs: NativeWorkflowRunInput[] = [];
    const lifecycle: string[] = [];
    let executedWorkflowSource: string | undefined;
    let executedAgentInstructions: string | undefined;
    let executedRuntimeConfig: string | undefined;
    let executedRoutingSource: string | undefined;
    const durableGraphStore = new FilesystemRunGraphStore({
      root: path.join(fixture.root, "run-graphs")
    });
    const graphStore: RunGraphSnapshotStorePort = {
      initialize: async () => await durableGraphStore.initialize(),
      writeGraph: async (snapshot) => {
        await durableGraphStore.writeGraph(snapshot);
        lifecycle.push("graph_durable");
      },
      writeOutcome: async (outcome) => {
        await durableGraphStore.writeOutcome(outcome);
        lifecycle.push("outcome_durable");
      },
      readGraph: async (handle) => await durableGraphStore.readGraph(handle),
      readOutcome: async (handle) =>
        await durableGraphStore.readOutcome(handle)
    };
    const ledger: RunLedgerPort = {
      preallocate: async (input) => await store.ledger.preallocate(input),
      appendTransition: async (input) => {
        const result = await store.ledger.appendTransition(input);
        if (input.transition.kind === "dispatch_started") {
          lifecycle.push("ledger_started");
        }
        if (
          input.transition.kind === "runtime_status" &&
          input.transition.status === "succeeded"
        ) {
          lifecycle.push("ledger_terminal");
        }
        return result;
      },
      get: async (runId) => await store.ledger.get(runId),
      listOrphanCandidates: async (input) =>
        await store.ledger.listOrphanCandidates(input)
    };
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger,
      graphStore,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "native-test-worker",
      schedule: (task) => scheduled.push(task),
      onBackgroundError: (cause) => backgroundErrors.push(cause),
      runWorkflow: async (input) => {
        runInputs.push(input);
        const roots = input.definitionRoots;
        if (roots === undefined) {
          throw new Error("Native execution must receive immutable definition roots");
        }
        [
          executedWorkflowSource,
          executedAgentInstructions,
          executedRuntimeConfig,
          executedRoutingSource
        ] = await Promise.all([
          readFile(path.join(
            roots.projectRoot,
            "workflows",
            "pinned-workflow",
            "workflow.yaml"
          ), "utf8"),
          readFile(path.join(
            roots.projectRoot,
            "agents",
            "pinned-agent",
            "instructions.md"
          ), "utf8"),
          readFile(path.join(
            roots.configRoot,
            "pinned-workflow.yaml"
          ), "utf8"),
          readFile(path.join(roots.configRoot, "routing.yaml"), "utf8")
        ]);
        return await successfulResult(input);
      }
    });
    try {
      await dispatcher.initialize();
      const first = await dispatcher.dispatch(command);
      const retry = await dispatcher.dispatch(command);
      expect(retry).toEqual(first);
      const adoptedPlanId = `rp_${"z".repeat(32)}`;
      await expect(dispatcher.dispatch({
        ...command,
        planId: adoptedPlanId
      })).resolves.toMatchObject({
        run_id: first.run_id,
        plan_id: adoptedPlanId,
        accepted_at: first.accepted_at
      });
      expect(scheduled).toHaveLength(3);
      const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      const queuedRun = await queue.read(first.run_id);
      const ledgerRecord = await store.ledger.get(first.run_id);
      expect(JSON.stringify(command)).not.toContain(confirmationToken);
      expect(JSON.stringify(first)).not.toContain(confirmationToken);
      expect(JSON.stringify(queuedRun)).not.toContain(confirmationToken);
      expect(JSON.stringify(ledgerRecord)).not.toContain(confirmationToken);
      expect(ledgerRecord).toMatchObject({
        accepted_plan_id: command.planId,
        input_provenance: command.request.input_provenance
      });

      await Promise.all([
        writeFile(fixture.workflowPath, "live workflow is now invalid\n"),
        writeFile(fixture.agentInstructionsPath, "live agent changed\n"),
        writeFile(fixture.runtimeConfigPath, "live config changed\n")
      ]);
      scheduled.splice(0).forEach((task) => task());
      await vi.waitFor(async () => {
        if (backgroundErrors[0] !== undefined) {
          throw backgroundErrors[0];
        }
        expect(await store.ledger.get(first.run_id)).toMatchObject({
          run_status: "succeeded"
        });
      });

      await vi.waitFor(() => {
        expect(lifecycle).toEqual([
          "graph_durable",
          "ledger_started",
          "outcome_durable",
          "ledger_terminal"
        ]);
      });
      await vi.waitFor(async () => {
        await expect(queue.listRunIds()).resolves.toEqual([]);
      });
      const completedRecord = await store.ledger.get(first.run_id);
      const graphHandle = completedRecord?.graph_snapshot_handle;
      expect(graphHandle).toBeDefined();
      const storedGraph = await durableGraphStore.readGraph(graphHandle ?? "");
      const storedOutcome = await durableGraphStore.readOutcome(
        graphHandle ?? ""
      );
      expect(storedGraph).toMatchObject({
        kind: "available",
        value: {
          identity: {
            run_id: first.run_id,
            workflow_revision: command.snapshot.workflow_revision,
            definition_bundle_hash: command.snapshot.definition_bundle_hash,
            execution_snapshot_hash: command.snapshot.execution_snapshot_hash
          },
          graph: {
            nodes: [{ id: "analyze", kind: "agent" }]
          }
        }
      });
      expect(storedOutcome).toMatchObject({
        kind: "available",
        value: {
          record_revision: completedRecord?.record_revision,
          run_status: "succeeded",
          nodes: [
            {
              node_id: "analyze",
              status: "succeeded",
              attempt_count: 1
            }
          ]
        }
      });
      expect(JSON.stringify(storedGraph)).not.toContain("accepted configuration");
      expect(JSON.stringify(storedGraph)).not.toContain("immutable definition");
      expect(JSON.stringify(storedOutcome)).not.toContain("output");

      expect(runInputs).toHaveLength(1);
      const input = runInputs[0];
      expect(JSON.stringify(input)).not.toContain(confirmationToken);
      expect(input?.run?.run_id).toBe(first.run_id);
      expect(input?.workflowConfig).toEqual(request.config);
      expect(input?.onSucceededState).toEqual(expect.any(Function));
      expect(input?.definitionRoots).toBeDefined();
      expect(input?.definitionRoots?.projectRoot).not.toBe(fixture.projectRoot);
      expect(input?.definitionRoots?.configRoot).not.toBe(fixture.configRoot);
      expect(executedWorkflowSource).toBe(fixture.workflowSource);
      expect(executedAgentInstructions).toBe(fixture.agentInstructions);
      expect(executedRuntimeConfig).toBe(fixture.runtimeConfig);
      expect(executedRoutingSource).toBe(fixture.routingSource);
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("adopts the original native run through a newly confirmed idempotent plan", async () => {
    const fixture = await writeFixture();
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const graphStore = new FilesystemRunGraphStore({
      root: path.join(fixture.root, "idempotent-plan-run-graphs")
    });
    const scheduled: Array<() => void> = [];
    let currentTime = BASE_TIME;
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      graphStore,
      platform: nativeLunaPlatformRegistrations,
      now: () => currentTime,
      ownerId: "idempotent-plan-test-worker",
      schedule: (task) => scheduled.push(task),
      runWorkflow: async () => {
        throw new Error("The idempotency acceptance test must not start work");
      }
    });
    const planIds = [
      `rp_${"a".repeat(32)}`,
      `rp_${"b".repeat(32)}`
    ];
    const service = launchService(fixture, dispatcher, {
      now: () => currentTime,
      createPlanId: () => {
        const planId = planIds.shift();
        if (planId === undefined) {
          throw new Error("Unexpected extra plan");
        }
        return planId;
      }
    });

    try {
      await dispatcher.initialize();
      const firstPlan = await service.plan(request, launchContext);
      const first = await service.execute(
        firstPlan.plan_id,
        executeRequest(firstPlan.confirmation_token),
        launchContext
      );
      currentTime += 30_000;
      const retryPlan = await service.plan(request, launchContext);
      const adopted = await service.execute(
        retryPlan.plan_id,
        executeRequest(retryPlan.confirmation_token),
        launchContext
      );

      expect(retryPlan.plan_id).not.toBe(firstPlan.plan_id);
      expect(adopted).toMatchObject({
        accepted: true,
        run_id: first.run_id,
        plan_id: retryPlan.plan_id,
        execution_snapshot_hash: first.execution_snapshot_hash,
        accepted_at: first.accepted_at
      });
      expect(scheduled).toHaveLength(2);
      await expect(store.ledger.get(first.run_id)).resolves.toMatchObject({
        accepted_plan_id: firstPlan.plan_id,
        run_id: first.run_id
      });
      const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      await expect(queue.read(first.run_id)).resolves.toMatchObject({
        accepted_plan_id: firstPlan.plan_id,
        idempotency_binding_hash: expect.any(String)
      });
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("persists an exact failed-node outcome before the terminal ledger transition", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    const lifecycle: string[] = [];
    const durableGraphStore = new FilesystemRunGraphStore({
      root: path.join(fixture.root, "failed-run-graphs")
    });
    const graphStore: RunGraphSnapshotStorePort = {
      initialize: async () => await durableGraphStore.initialize(),
      writeGraph: async (snapshot) => {
        await durableGraphStore.writeGraph(snapshot);
        lifecycle.push("graph_durable");
      },
      writeOutcome: async (outcome) => {
        lifecycle.push("outcome_started");
        await durableGraphStore.writeOutcome(outcome);
        lifecycle.push("outcome_durable");
      },
      readGraph: async (handle) => await durableGraphStore.readGraph(handle),
      readOutcome: async (handle) => await durableGraphStore.readOutcome(handle)
    };
    const ledger: RunLedgerPort = {
      preallocate: async (input) => await store.ledger.preallocate(input),
      appendTransition: async (input) => {
        const mutation = await store.ledger.appendTransition(input);
        if (input.transition.kind === "dispatch_started") {
          lifecycle.push("ledger_started");
        }
        if (
          input.transition.kind === "runtime_status" &&
          input.transition.status === "failed"
        ) {
          lifecycle.push("ledger_terminal");
        }
        return mutation;
      },
      get: async (runId) => await store.ledger.get(runId),
      listOrphanCandidates: async (input) =>
        await store.ledger.listOrphanCandidates(input)
    };
    const runtimeFailure = Object.assign(new Error("native node failed"), {
      code: "runtime_node_output_schema_invalid"
    });
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger,
      graphStore,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "failed-run-worker",
      schedule: (task) => scheduled.push(task),
      runWorkflow: async (input) => await failedResult(input, runtimeFailure)
    });
    try {
      await dispatcher.initialize();
      const receipt = await dispatcher.dispatch(command);
      scheduled.splice(0).forEach((task) => task());
      await waitForRun(ledger, receipt.run_id, "failed");
      await vi.waitFor(() => {
        expect(lifecycle).toEqual([
          "graph_durable",
          "ledger_started",
          "outcome_started",
          "outcome_durable",
          "ledger_terminal"
        ]);
      });

      const terminalRecord = await ledger.get(receipt.run_id);
      if (terminalRecord === undefined) {
        throw new Error("Expected a terminal failed run record");
      }
      expect(terminalRecord).toMatchObject({
        run_status: "failed",
        failed_node_id: "analyze",
        failure: { code: "runtime_node_output_schema_invalid" }
      });
      const handle = terminalRecord.graph_snapshot_handle;
      if (handle === undefined) {
        throw new Error("Expected a failed run graph snapshot handle");
      }
      await expect(durableGraphStore.readOutcome(handle)).resolves.toMatchObject({
        kind: "available",
        value: {
          record_revision: terminalRecord.record_revision,
          run_status: "failed",
          nodes: [{
            node_id: "analyze",
            status: "failed",
            attempt_count: 1
          }]
        }
      });
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("rejects a runner that skips the compiled workflow durability barrier", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const graphStore = new FilesystemRunGraphStore({
      root: path.join(fixture.root, "barrier-run-graphs")
    });
    const scheduled: Array<() => void> = [];
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      graphStore,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "barrier-test-worker",
      schedule: (task) => scheduled.push(task),
      runWorkflow: async (input) => {
        const { onCompiledWorkflow: _barrier, ...withoutBarrier } = input;
        return await successfulResult(withoutBarrier);
      }
    });
    try {
      await dispatcher.initialize();
      const receipt = await dispatcher.dispatch(command);
      scheduled.splice(0).forEach((task) => task());

      await vi.waitFor(async () => {
        expect(await store.ledger.get(receipt.run_id)).toMatchObject({
          dispatch_status: "rejected",
          failure: {
            code: "studio_run_dispatch_failed"
          }
        });
      });
      const rejected = await store.ledger.get(receipt.run_id);
      expect(rejected?.run_status).toBeUndefined();
      const handle = rejected?.graph_snapshot_handle;
      expect(handle).toEqual(expect.any(String));
      if (handle === undefined) {
        throw new Error("Expected a preallocated graph snapshot handle");
      }
      expect(await graphStore.readGraph(handle)).toEqual({ kind: "missing" });
      expect(await graphStore.readOutcome(handle)).toEqual({ kind: "missing" });
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("rejects definition bytes changed during compilation before starting the lease", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "definition-toctou-worker",
      schedule: (task) => scheduled.push(task),
      runWorkflow: async (input) => await successfulResult(input, {
        beforeCompiledBarrier: async () => {
          const roots = input.definitionRoots;
          if (roots === undefined) throw new Error("Expected pinned definition roots");
          await writeFile(
            path.join(roots.projectRoot, "workflows", "pinned-workflow", "workflow.yaml"),
            `${fixture.workflowSource}\n# changed during compile\n`,
            "utf8"
          );
        }
      })
    });
    try {
      await dispatcher.initialize();
      const receipt = await dispatcher.dispatch(command);
      scheduled.splice(0).forEach((task) => task());

      await vi.waitFor(async () => {
        expect(await store.ledger.get(receipt.run_id)).toMatchObject({
          dispatch_status: "rejected",
          failure: { code: "studio_run_plan_resolution_invalid" }
        });
      });
      expect(await store.ledger.get(receipt.run_id)).not.toHaveProperty("run_status");
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("rejects a waiting result without durable interrupt identity", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "invalid-waiting-result-worker",
      schedule: (task) => scheduled.push(task),
      runWorkflow: async (input) => {
        const context = await loadNativeRunContext(input, {
          platform: nativeLunaPlatformRegistrations
        });
        await input.onCompiledWorkflow?.(context.nativeWorkflow.compiled);
        if (input.run === undefined) throw new Error("Expected preallocated run");
        const invocation = input.invocation;
        const config = input.workflowConfig ?? {};
        assertCheckpointJsonValue(invocation);
        assertCheckpointJsonValue(config);
        return {
          status: "waiting_for_input",
          state: {
            ...createInitialRuntimeState({
              invocation,
              config,
              run: input.run,
              workflow: { id: "pinned-workflow", mode: "read_only" }
            }),
            run_status: "waiting_for_input"
          }
        };
      }
    });
    try {
      await dispatcher.initialize();
      const receipt = await dispatcher.dispatch(command);
      scheduled.splice(0).forEach((task) => task());

      await vi.waitFor(async () => {
        expect(await store.ledger.get(receipt.run_id)).toMatchObject({
          dispatch_status: "started",
          run_status: "failed",
          failure: { code: "studio_run_dispatch_failed" }
        });
      });
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("keeps a started job recoverable when checkpoint acceptance is unknown", async () => {
    const fixture = await writeFixture();
    await writeFile(fixture.workflowPath, replaySafeBuiltInWorkflowSource());
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    const backgroundErrors: unknown[] = [];
    let executions = 0;
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "acceptance-unknown-worker",
      schedule: (task) => scheduled.push(task),
      onBackgroundError: (cause) => backgroundErrors.push(cause),
      runWorkflow: async (input) => {
        executions += 1;
        return await successfulResult(input, executions === 1
          ? {
              afterStart: async () => {
                throw new CheckpointWriteAcceptanceUnknownError(
                  {
                    thread_id: input.run?.run_id ?? "missing-run",
                    checkpoint_ns: "",
                    checkpoint_id: "node-output-analyze",
                    task_id: "analyze",
                    index: 0,
                    channel: "steps",
                    value: { accepted: "unknown" }
                  },
                  new Error("checkpoint acknowledgement lost"),
                  new Error("checkpoint readback unavailable")
                );
              }
            }
          : {});
      }
    });
    try {
      await dispatcher.initialize();
      const receipt = await dispatcher.dispatch(command);
      scheduled.splice(0).forEach((task) => task());
      await vi.waitFor(() => {
        expect(backgroundErrors[0]).toBeInstanceOf(
          CheckpointWriteAcceptanceUnknownError
        );
      });
      const retained = await store.ledger.get(receipt.run_id);
      expect(retained).toMatchObject({
        dispatch_status: "started",
        run_status: "running"
      });
      expect(retained).not.toHaveProperty("failure");
      const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      await expect(queue.listRunIds()).resolves.toContain(receipt.run_id);
      const recoveryJournal = new NativeStudioRunRecoveryJournal({
        queueRoot: fixture.queueRoot
      });
      await expect(recoveryJournal.read(receipt.run_id)).resolves.toMatchObject({
        run_id: receipt.run_id,
        execution_snapshot_hash: command.snapshot.execution_snapshot_hash,
        reason: "runtime_durability_recovery_required"
      });

      await dispatcher.close();
      const recoveryTasks: Array<() => void> = [];
      const recoveryErrors: unknown[] = [];
      const recoveryNow = Date.parse(retained?.heartbeat_at ?? "") + 120_000;
      const recovered = new NativeStudioRunDispatcher({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        queueRoot: fixture.queueRoot,
        ledger: store.ledger,
        platform: nativeLunaPlatformRegistrations,
        now: () => recoveryNow,
        ownerId: "acceptance-unknown-recovery-worker",
        heartbeatIntervalMs: 1_000,
        orphanThresholdMs: 3_000,
        schedule: (task) => recoveryTasks.push(task),
        onBackgroundError: (cause) => recoveryErrors.push(cause),
        runWorkflow: async (input) => {
          executions += 1;
          return await successfulResult(input);
        }
      });
      try {
        await recovered.initialize();
        expect(recoveryTasks).toHaveLength(1);
        recoveryTasks.splice(0).forEach((task) => task());
        await vi.waitFor(async () => {
          if (recoveryErrors[0] !== undefined) {
            throw recoveryErrors[0];
          }
          expect(await store.ledger.get(receipt.run_id)).toMatchObject({
            dispatch_status: "started",
            run_status: "succeeded",
            owner_id: "acceptance-unknown-recovery-worker"
          });
          expect(await queue.listRunIds()).not.toContain(receipt.run_id);
        });
        expect(executions).toBe(2);
        expect(recoveryErrors).toEqual([]);
      } finally {
        await recovered.close();
      }
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("requires manual review instead of replaying checkpoint-unknown write effects", async () => {
    const fixture = await writeFixture();
    await writeFile(
      fixture.workflowPath,
      policyBearingAgentAndPatternSource(fixture)
    );
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    let executions = 0;
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "write-acceptance-unknown-owner",
      schedule: (task) => scheduled.push(task),
      onBackgroundError: () => undefined,
      runWorkflow: async (input) => {
        executions += 1;
        return await successfulResult(input, {
          afterStart: async () => {
            throw new CheckpointWriteAcceptanceUnknownError(
              {
                thread_id: input.run?.run_id ?? "missing-run",
                checkpoint_ns: "",
                checkpoint_id: "write-node-output",
                task_id: "analyze",
                index: 0,
                channel: "steps",
                value: { external_write: "acceptance_unknown" }
              },
              new Error("write acknowledgement lost"),
              new Error("write checkpoint readback unavailable")
            );
          }
        });
      }
    });
    try {
      await dispatcher.initialize();
      const receipt = await dispatcher.dispatch(command);
      scheduled.splice(0).forEach((task) => task());
      await vi.waitFor(async () => {
        expect(await store.ledger.get(receipt.run_id)).toMatchObject({
          run_status: "outcome_unknown",
          completeness: "partial",
          failure: { code: "studio_runtime_checkpoint_outcome_unknown" }
        });
      });
      const recoveryJournal = new NativeStudioRunRecoveryJournal({
        queueRoot: fixture.queueRoot
      });
      await expect(recoveryJournal.read(receipt.run_id)).resolves.toBeUndefined();

      await dispatcher.close();
      let recoveryExecutions = 0;
      const recovered = new NativeStudioRunDispatcher({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        queueRoot: fixture.queueRoot,
        ledger: store.ledger,
        platform: nativeLunaPlatformRegistrations,
        now: () => BASE_TIME + 120_000,
        ownerId: "write-acceptance-unknown-observer",
        heartbeatIntervalMs: 1_000,
        orphanThresholdMs: 3_000,
        onBackgroundError: () => undefined,
        runWorkflow: async (input) => {
          recoveryExecutions += 1;
          return await successfulResult(input);
        }
      });
      try {
        await recovered.initialize();
        expect(recoveryExecutions).toBe(0);
        expect(executions).toBe(1);
        const queue = new NativeStudioRunDispatchQueue({
          root: fixture.queueRoot
        });
        await expect(queue.inspect(receipt.run_id)).resolves.toBe("missing");
      } finally {
        await recovered.close();
      }
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("marks a stale run unknown when its recovery authorization is corrupt", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "corrupt-recovery-intent-dispatcher",
      schedule: (task) => scheduled.push(task),
      onBackgroundError: () => undefined,
      runWorkflow: async () => {
        throw new Error("manually staged run must not execute")
      }
    });
    try {
      await dispatcher.initialize();
      const receipt = await dispatcher.dispatch(command);
      await store.ledger.appendTransition({
        run_id: receipt.run_id,
        transition_id: "prepare-corrupt-recovery-intent",
        event_id: "event-prepare-corrupt-recovery-intent",
        expected_revision: 1,
        occurred_at: new Date(BASE_TIME + 1).toISOString(),
        transition: {
          kind: "dispatch_preparing",
          owner_id: "corrupt-recovery-intent-owner"
        }
      });
      await store.ledger.appendTransition({
        run_id: receipt.run_id,
        transition_id: "start-corrupt-recovery-intent",
        event_id: "event-start-corrupt-recovery-intent",
        expected_revision: 2,
        occurred_at: new Date(BASE_TIME + 2).toISOString(),
        transition: {
          kind: "dispatch_started",
          owner_id: "corrupt-recovery-intent-owner",
          active_node_ids: ["analyze"]
        }
      });
      await writeFile(path.join(
        fixture.queueRoot,
        "jobs",
        receipt.run_id,
        "recovery.json"
      ), "{", "utf8");
      await dispatcher.close();

      let recoveryExecutions = 0;
      const recovered = new NativeStudioRunDispatcher({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        queueRoot: fixture.queueRoot,
        ledger: store.ledger,
        platform: nativeLunaPlatformRegistrations,
        now: () => BASE_TIME + 120_000,
        ownerId: "corrupt-recovery-intent-observer",
        heartbeatIntervalMs: 1_000,
        orphanThresholdMs: 3_000,
        onBackgroundError: () => undefined,
        runWorkflow: async (input) => {
          recoveryExecutions += 1;
          return await successfulResult(input);
        }
      });
      try {
        await recovered.initialize();
        await expect(store.ledger.get(receipt.run_id)).resolves.toMatchObject({
          run_status: "outcome_unknown",
          completeness: "partial",
          failure: { code: "studio_runtime_recovery_intent_invalid" }
        });
        expect(recoveryExecutions).toBe(0);
      } finally {
        await recovered.close();
      }
    } finally {
      await dispatcher.close();
      store.close();
    }
  });
});
