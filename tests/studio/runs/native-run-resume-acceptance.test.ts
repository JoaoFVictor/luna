import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InterruptRecord } from "../../../src/core/runtime/interrupts/contracts.js";
import type { LunaRuntimeState } from "../../../src/core/runtime/state.js";
import { sha256Digest } from "../../../src/core/workflow/definition-digests.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { RunGraphService } from "../../../src/studio/application/runs/graph-service.js";
import { FilesystemRunGraphStore } from "../../../src/studio/adapters/filesystem/run-graph-store.js";
import { NativeStudioRunDispatcher } from "../../../src/studio/adapters/native/run-dispatcher.js";
import { NativeStudioRunDispatchQueue } from "../../../src/studio/adapters/filesystem/run-dispatch-queue.js";
import { createSqliteRunStore } from "../../../src/studio/adapters/sqlite/run-store.js";
import {
  BASE_TIME,
  captureCommand,
  cleanupNativeLaunchFixtures,
  waitForRun,
  writeFixture
} from "./native-run-launch-test-support.js";
import {
  interruptPort,
  interruptRecord,
  succeededResumeState,
  waitingResult
} from "./native-run-resume-test-support.js";

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});

describe("native Studio resume acceptance and observability", () => {
  it("converges concurrent exact accepts with different clocks on the first audit timestamp", async () => {
    const fixture = await writeFixture();
    const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
    await queue.initialize();
    const decision = { action: "approve" };
    const base = {
      schema_version: 1 as const,
      resume_id: "resume-concurrent-clock",
      run_id: "run-concurrent-clock",
      interrupt_id: "interrupt-concurrent-clock",
      thread_id: "thread-concurrent-clock",
      checkpoint_id: "checkpoint-concurrent-clock",
      workflow_id: "pinned-workflow",
      owner_id: "concurrent-owner",
      execution_snapshot_hash: sha256Digest({ snapshot: true }),
      decision,
      decision_hash: sha256Digest(decision)
    };
    const times = [
      "2026-07-12T00:00:01.000Z",
      "2026-07-12T00:00:09.000Z"
    ] as const;
    const accepted = await Promise.all(times.map(async (accepted_at) =>
      await queue.acceptResume({ ...base, accepted_at })
    ));

    expect(accepted.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(accepted.map((result) => result.job.command_hash))).toHaveLength(1);
    expect(new Set(accepted.map((result) => result.job.accepted_at))).toHaveLength(1);
    expect(times).toContain(accepted[0]!.job.accepted_at as typeof times[number]);
    expect(await queue.readResumeIdentity(base.resume_id)).toMatchObject({
      accepted_at: accepted[0]!.job.accepted_at,
      command_hash: accepted[0]!.job.command_hash
    });
  });

  it("keeps the live graph observable when a later resume reuses the runtime attempt number", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const graphStore = new FilesystemRunGraphStore({
      root: path.join(fixture.root, "resume-observable-graphs")
    });
    const scheduled: Array<() => void> = [];
    const interrupts = new Map<string, InterruptRecord>();
    let waitingState: LunaRuntimeState | undefined;
    const lifecycleEvent = (occurredAt: string) => ({
      type: "node.started" as const,
      node_id: "analyze",
      attempt: 1,
      occurred_at: occurredAt,
      artifact_count: 0,
      interrupt_count: 0
    });
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      graphStore,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 20_000,
      ownerId: "resume-observable-worker",
      schedule: (task) => scheduled.push(task),
      runWorkflow: async (input) => {
        const result = await waitingResult(input);
        waitingState = result.state;
        await input.onLifecycleEvent?.(
          lifecycleEvent("2026-07-11T12:00:10.000Z")
        );
        return result;
      },
      resume: {
        interrupts: interruptPort(interrupts),
        platform: nativeLunaPlatformRegistrations,
        runWorkflow: async (input) => {
          await input.onLifecycleEvent?.(
            lifecycleEvent("2026-07-11T12:00:30.000Z")
          ).catch(() => undefined);
          return {
            status: "waiting_for_input",
            interrupt_id: "interrupt-2",
            checkpoint_id: "checkpoint-2",
            state: waitingState!
          };
        }
      }
    });
    try {
      await dispatcher.initialize();
      const launch = await dispatcher.dispatch(command);
      scheduled.splice(0).forEach((task) => task());
      await vi.waitFor(async () => {
        expect(await store.ledger.get(launch.run_id)).toMatchObject({
          run_status: "waiting_for_input",
          lifecycle_projection: "exact"
        });
      });
      const interrupt = interruptRecord(launch.run_id);
      interrupts.set(interrupt.id, interrupt);

      await dispatcher.resume({
        runId: launch.run_id,
        interrupt,
        decision: { action: "approve" }
      });
      scheduled.splice(0).forEach((task) => task());
      await vi.waitFor(async () => {
        expect(await store.ledger.get(launch.run_id)).toMatchObject({
          run_status: "waiting_for_input",
          lifecycle_projection: "exact"
        });
      });

      const graph = await new RunGraphService({
        ledger: store.ledger,
        events: store.events,
        store: graphStore
      }).get(launch.run_id);
      expect(graph).toMatchObject({
        availability: "available",
        overlay: {
          observation: "observed",
          source: "live",
          nodes: [{
            node_id: "analyze",
            status: "waiting_for_input",
            attempt_count: 1
          }]
        }
      });
      const lifecycle = await store.events.list({
        run_id: launch.run_id,
        direction: "asc",
        event_types: ["run.node.started"],
        limit: 10
      });
      expect(lifecycle.items).toHaveLength(2);
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("durably accepts an exact duplicate and runs it once from the pinned snapshot", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    const interrupts = new Map<string, InterruptRecord>();
    let waitingState: LunaRuntimeState | undefined;
    let resumeExecutions = 0;
    let now = BASE_TIME + 20_000;
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => now,
      ownerId: "durable-resume-worker",
      schedule: (task) => scheduled.push(task),
      runWorkflow: async (input) => {
        const result = await waitingResult(input);
        waitingState = result.state;
        return result;
      },
      resume: {
        interrupts: interruptPort(interrupts),
        platform: nativeLunaPlatformRegistrations,
        runWorkflow: async (input) => {
          resumeExecutions += 1;
          expect(input.definitionRoots).toBeDefined();
          const pinned = await readFile(path.join(
            input.definitionRoots!.projectRoot,
            "workflows",
            "pinned-workflow",
            "workflow.yaml"
          ), "utf8");
          expect(pinned).toBe(fixture.workflowSource);
          const state = succeededResumeState(waitingState!);
          const interrupt = interrupts.get("interrupt-1")!;
          interrupts.set("interrupt-1", {
            ...interrupt,
            status: "resolved",
            resume: {
              interrupt_id: interrupt.id,
              resume_id: "resume-interrupt-1",
              input: {
                interrupt_id: interrupt.id,
                thread_id: input.thread_id,
                checkpoint_id: input.checkpoint_id,
                decision: input.decision
              },
              decision: input.decision,
              created_at: new Date(BASE_TIME + 30_000).toISOString()
            },
            updated_at: new Date(BASE_TIME + 30_000).toISOString()
          });
          await input.onSucceededState?.(state);
          return { status: "succeeded", output: {}, state };
        }
      }
    });
    try {
      await dispatcher.initialize();
      const launch = await dispatcher.dispatch(command);
      scheduled.shift()?.();
      await vi.waitFor(async () => {
        expect(await store.ledger.get(launch.run_id)).toMatchObject({
          run_status: "waiting_for_input"
        });
      });
      const interrupt = interruptRecord(launch.run_id);
      interrupts.set(interrupt.id, interrupt);
      await writeFile(fixture.workflowPath, fixture.workflowSource.replace("pinned-workflow", "mutated-workflow"));

      const decision = { action: "approve" as const };
      const first = await dispatcher.resume({ runId: launch.run_id, interrupt, decision });
      const resumeFiles = await readdir(path.join(fixture.queueRoot, "resumes"));
      expect(resumeFiles).toHaveLength(1);
      expect(JSON.parse(await readFile(
        path.join(fixture.queueRoot, "resumes", resumeFiles[0]!),
        "utf8"
      ))).toMatchObject({
        accepted_at: new Date(BASE_TIME + 20_000).toISOString()
      });
      now = BASE_TIME + 90_000;
      const duplicate = await dispatcher.resume({ runId: launch.run_id, interrupt, decision });
      expect(JSON.parse(await readFile(
        path.join(fixture.queueRoot, "resumes", resumeFiles[0]!),
        "utf8"
      ))).toMatchObject({
        accepted_at: new Date(BASE_TIME + 20_000).toISOString()
      });
      await expect(dispatcher.resume({
        runId: launch.run_id,
        interrupt,
        decision: { action: "reject" }
      })).rejects.toMatchObject({ code: "run_idempotency_conflict" });

      expect(first).toMatchObject({ accepted: true, resume_status: "resuming", already_resumed: false });
      expect(duplicate).toMatchObject({ accepted: true, resume_status: "resuming", already_resumed: false });
      expect(resumeExecutions).toBe(0);
      expect(await store.ledger.get(launch.run_id)).toMatchObject({ run_status: "resuming" });
      expect(interrupts.get("interrupt-1")).toMatchObject({
        status: "resuming",
        resume_input: { decision }
      });

      scheduled.splice(0).forEach((task) => task());
      await waitForRun(store.ledger, launch.run_id, "succeeded");
      expect(resumeExecutions).toBe(1);
    } finally {
      await dispatcher.close();
      store.close();
    }
  });
});
