import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InterruptRecord } from "../../../src/core/runtime/interrupts/contracts.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { NativeStudioRunDispatchQueue } from "../../../src/studio/adapters/filesystem/run-dispatch-queue.js";
import { NativeStudioRunDispatcher } from "../../../src/studio/adapters/native/run-dispatcher.js";
import { createSqliteRunStore } from "../../../src/studio/adapters/sqlite/run-store.js";
import {
  BASE_TIME,
  captureCommand,
  cleanupNativeLaunchFixtures,
  writeFixture
} from "./native-run-launch-test-support.js";
import {
  driftedCapabilityPlatform,
  interruptPort,
  interruptRecord,
  waitingResult
} from "./native-run-resume-test-support.js";

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});

describe("native Studio resume effect recovery", () => {
  it("treats a loop image effect's pre-node resume journal as an authoritative barrier", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const imagePotential = {
      effect_id: "effect-generate-social-image-barrier",
      category: "model_call" as const,
      description: "Generate the loop image only after the durable resume barrier",
      confirmation_required: false,
      retry_semantics: "retry_forbidden" as const,
      idempotency_scope: "attempt" as const,
      operation_id: "image-generation.generate",
      policy_id: "image-generation.generate_side_effect",
      registration_id: "image-generation.generate",
      node_id: "editorial/image"
    };
    const writeCommand = {
      ...command,
      resolution: {
        ...command.resolution,
        potential_effects: [
          ...command.resolution.potential_effects,
          imagePotential
        ],
        resolved_effects: [
          ...command.resolution.resolved_effects,
          {
            ...imagePotential,
            effect_id: "resolved-generate-social-image-barrier",
            potential_effect_id: imagePotential.effect_id,
            resolution_source: "preflight" as const
          }
        ]
      }
    };
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const interrupts = new Map<string, InterruptRecord>();
    const scheduled: Array<() => void> = [];
    let unsafeExecutions = 0;
    const markBarrier = vi.spyOn(
      NativeStudioRunDispatchQueue.prototype,
      "markResumeEffectMayHaveOccurred"
    ).mockRejectedValue(new Error("simulated resume-stage fsync failure"));
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 20_000,
      ownerId: "resume-barrier-owner",
      schedule: (task) => scheduled.push(task),
      runWorkflow: waitingResult,
      resume: {
        interrupts: interruptPort(interrupts),
        platform: nativeLunaPlatformRegistrations,
        runWorkflow: async (input) => {
          await input.onBeforeNodeExecution?.({
            node_id: "editorial:iteration-1:image",
            attempt: 1
          });
          unsafeExecutions += 1;
          throw new Error("Unsafe publish must remain unreachable");
        }
      }
    });
    try {
      await dispatcher.initialize();
      const launch = await dispatcher.dispatch(writeCommand);
      scheduled.shift()?.();
      await vi.waitFor(async () => {
        expect(await store.ledger.get(launch.run_id)).toMatchObject({
          run_status: "waiting_for_input"
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
          run_status: "outcome_unknown",
          failure: { code: "studio_runtime_write_outcome_unknown" }
        });
      });
      expect(markBarrier).toHaveBeenCalledTimes(1);
      expect(unsafeExecutions).toBe(0);
      await vi.waitFor(async () => {
        expect(await readdir(path.join(fixture.queueRoot, "resumes"))).toHaveLength(0);
        expect(await readdir(path.join(fixture.queueRoot, "resume-stages"))).toHaveLength(0);
      });
    } finally {
      markBarrier.mockRestore();
      await dispatcher.close();
      store.close();
    }
  });

  it.each([
    [false, "studio_runtime_resume_write_outcome_unknown"],
    [true, "studio_run_resume_catalog_changed"]
  ] as const)(
  "does not replay a publish after a resumed checkpoint (catalog drift: %s)",
  async (catalogDrifted, expectedFailureCode) => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const publishPotential = {
      effect_id: "effect-publish-social-post",
      category: "external_write" as const,
      description: "Publish the approved social post to X",
      confirmation_required: true,
      retry_semantics: "retry_requires_adoption" as const,
      idempotency_scope: "external_resource" as const,
      operation_id: "social-post.publish",
      policy_id: "social-post.publish-policy",
      registration_id: "social-post.publish",
      node_id: "publish_post"
    };
    const writeCommand = {
      ...command,
      resolution: {
        ...command.resolution,
        potential_effects: [
          ...command.resolution.potential_effects,
          publishPotential
        ],
        resolved_effects: [
          ...command.resolution.resolved_effects,
          {
            ...publishPotential,
            effect_id: "resolved-publish-social-post",
            potential_effect_id: publishPotential.effect_id,
            resolution_source: "preflight" as const
          }
        ]
      }
    };
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const interrupts = new Map<string, InterruptRecord>();
    const durableInterrupts = interruptPort(interrupts);
    const firstTasks: Array<() => void> = [];
    const first = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 20_000,
      ownerId: "publish-resume-crashed-owner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => firstTasks.push(task),
      runWorkflow: waitingResult,
      resume: {
        interrupts: durableInterrupts,
        platform: nativeLunaPlatformRegistrations
      }
    });
    let runId: string | undefined;
    try {
      await first.initialize();
      const launch = await first.dispatch(writeCommand);
      runId = launch.run_id;
      firstTasks.shift()?.();
      await vi.waitFor(async () => {
        expect(await store.ledger.get(launch.run_id)).toMatchObject({
          run_status: "waiting_for_input"
        });
      });
      const interrupt = interruptRecord(launch.run_id);
      interrupts.set(interrupt.id, interrupt);
      await first.resume({
        runId: launch.run_id,
        interrupt,
        decision: { action: "approve" }
      });
      let record = await store.ledger.get(launch.run_id);
      if (record?.owner_id === undefined) throw new Error("Expected resume owner");
      await store.ledger.appendTransition({
        run_id: launch.run_id,
        transition_id: "simulate-publish-resume-running",
        event_id: "event-simulate-publish-resume-running",
        expected_revision: record.record_revision,
        occurred_at: new Date(BASE_TIME + 21_000).toISOString(),
        transition: {
          kind: "runtime_status",
          owner_id: record.owner_id,
          status: "running",
          active_node_ids: []
        }
      });
      record = await store.ledger.get(launch.run_id);
      if (record?.owner_id === undefined) throw new Error("Expected running owner");
      await store.ledger.appendTransition({
        run_id: launch.run_id,
        transition_id: "simulate-publish-node-started",
        event_id: "event-simulate-publish-node-started",
        expected_revision: record.record_revision,
        occurred_at: new Date(BASE_TIME + 22_000).toISOString(),
        transition: {
          kind: "node_lifecycle",
          owner_id: record.owner_id,
          event: {
            type: "node.started",
            node_id: "publish_post",
            attempt: 1,
            observed_at: new Date(BASE_TIME + 22_000).toISOString(),
            artifact_count: 0,
            interrupt_count: 1
          }
        }
      });
      const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      const queuedResumeIds = await queue.listResumeIds();
      const queuedResumeId = queuedResumeIds[0];
      if (queuedResumeId === undefined) throw new Error("Expected queued resume");
      const queuedResume = await queue.readResume(queuedResumeId);
      await queue.markResumeEffectMayHaveOccurred(
        queuedResume,
        "publish_post"
      );
      const claimed = interrupts.get(interrupt.id);
      if (
        claimed?.resume_attempt === undefined ||
        claimed.resume_input === undefined
      ) throw new Error("Expected claimed resume");
      interrupts.set(interrupt.id, {
        ...claimed,
        status: "resolved",
        resume_input: undefined,
        resume: {
          interrupt_id: interrupt.id,
          resume_id: claimed.resume_attempt,
          input: claimed.resume_input,
          decision: claimed.resume_input.decision,
          created_at: new Date(BASE_TIME + 21_000).toISOString()
        },
        updated_at: new Date(BASE_TIME + 21_000).toISOString()
      });
    } finally {
      await first.close();
    }

    if (runId === undefined) throw new Error("Expected launched run");
    const recoveryTasks: Array<() => void> = [];
    const recoveryErrors: unknown[] = [];
    let initialExecutions = 0;
    let resumeExecutions = 0;
    let publishCalls = 0;
    const recovered = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 40_000,
      ownerId: "publish-resume-recovery-owner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => recoveryTasks.push(task),
      onBackgroundError: (cause) => recoveryErrors.push(cause),
      runWorkflow: async () => {
        initialExecutions += 1;
        throw new Error("Initial workflow must not replay");
      },
      resume: {
        interrupts: durableInterrupts,
        platform: catalogDrifted
          ? driftedCapabilityPlatform()
          : nativeLunaPlatformRegistrations,
        runWorkflow: async () => {
          resumeExecutions += 1;
          publishCalls += 1;
          throw new Error("Unsafe publish resume must not execute");
        }
      }
    });
    try {
      await recovered.initialize();
      expect(recoveryErrors).toEqual([]);
      expect(recoveryTasks).toHaveLength(0);
      expect(initialExecutions).toBe(0);
      expect(resumeExecutions).toBe(0);
      expect(publishCalls).toBe(0);
      expect(await store.ledger.get(runId)).toMatchObject({
        run_status: "outcome_unknown",
        owner_id: "publish-resume-recovery-owner",
        failure: { code: expectedFailureCode }
      });
      expect(interrupts.get("interrupt-1")).toMatchObject({
        status: "resolved",
        resume: { decision: { action: "approve" } }
      });
      expect(await readdir(path.join(fixture.queueRoot, "resumes"))).toHaveLength(0);
    } finally {
      await recovered.close();
      store.close();
    }
  });
});
