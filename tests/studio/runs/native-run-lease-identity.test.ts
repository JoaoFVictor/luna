import { describe, expect, it, vi } from "vitest";
import {
  NativeStudioRunLease,
  type NativeStudioRunRecoveryClaim
} from "../../../src/studio/adapters/native/run-dispatch-lease.js";
import type {
  AppendRunTransitionInput,
  RunLedgerPort
} from "../../../src/studio/application/runs/ports.js";
import type { RunRecord } from "../../../src/studio/contracts/runs.js";
import { DIGEST_A, preallocation, withRunStore } from "./helpers.js";

const BASE_TIME = Date.parse("2026-07-10T12:00:00.000Z");
const RUN_ID = "lease-instance-identity";
const RECOVERY_OWNER = "o".repeat(256);

function recoveryClaim(
  record: RunRecord,
  staleBefore: string
): NativeStudioRunRecoveryClaim {
  if (record.owner_id === undefined || record.heartbeat_at === undefined) {
    throw new Error("Expected an owned running record");
  }
  return {
    run_id: record.run_id,
    previous_owner_id: record.owner_id,
    expected_revision: record.record_revision,
    expected_heartbeat_at: record.heartbeat_at,
    stale_before: staleBefore,
    recovery_intent_hash: DIGEST_A
  };
}

describe("native Studio run lease transition identity", () => {
  it("deduplicates one resume execution but separates a later resume with the same attempt number", async () => {
    await withRunStore(async ({ store }) => {
      await store.ledger.preallocate(preallocation(RUN_ID));
      await store.ledger.appendTransition({
        run_id: RUN_ID,
        transition_id: "prepare-lifecycle-execution",
        event_id: "event-prepare-lifecycle-execution",
        expected_revision: 1,
        occurred_at: new Date(BASE_TIME + 1).toISOString(),
        transition: {
          kind: "dispatch_preparing",
          owner_id: "lifecycle-owner"
        }
      });
      await store.ledger.appendTransition({
        run_id: RUN_ID,
        transition_id: "start-lifecycle-execution",
        event_id: "event-start-lifecycle-execution",
        expected_revision: 2,
        occurred_at: new Date(BASE_TIME + 2).toISOString(),
        transition: {
          kind: "dispatch_started",
          owner_id: "lifecycle-owner",
          active_node_ids: []
        }
      });
      const lease = (lifecycleExecutionId: string) =>
        new NativeStudioRunLease({
          ledger: store.ledger,
          runId: RUN_ID,
          ownerId: "lifecycle-owner",
          now: () => BASE_TIME + 10_000,
          heartbeatIntervalMs: 1_000,
          lifecycleExecutionId
        });
      const firstEvent = {
        type: "node.started" as const,
        node_id: "editorial",
        attempt: 1,
        occurred_at: new Date(BASE_TIME + 3).toISOString(),
        artifact_count: 0,
        interrupt_count: 0
      };

      await lease("resume-command-1").observeNode(firstEvent);
      await lease("resume-command-1").observeNode(firstEvent);
      await lease("resume-command-2").observeNode({
        ...firstEvent,
        occurred_at: new Date(BASE_TIME + 4).toISOString()
      });

      const events = await store.events.list({
        run_id: RUN_ID,
        direction: "asc",
        event_types: ["run.node.started"],
        limit: 10
      });
      expect(events.items).toHaveLength(2);
      await expect(store.ledger.get(RUN_ID)).resolves.toMatchObject({
        lifecycle_projection: "exact",
        active_node_ids: ["editorial"]
      });
    });
  });

  it("does not reuse mutable ids across consecutive recoveries by the same owner", async () => {
    vi.useFakeTimers();
    try {
      await withRunStore(async ({ store }) => {
        await store.ledger.preallocate(preallocation(RUN_ID));
        await store.ledger.appendTransition({
          run_id: RUN_ID,
          transition_id: "prepare-lease-instance-identity",
          event_id: "event-prepare-lease-instance-identity",
          expected_revision: 1,
          occurred_at: new Date(BASE_TIME + 1).toISOString(),
          transition: {
            kind: "dispatch_preparing",
            owner_id: "original-owner"
          }
        });
        await store.ledger.appendTransition({
          run_id: RUN_ID,
          transition_id: "start-lease-instance-identity",
          event_id: "event-start-lease-instance-identity",
          expected_revision: 2,
          occurred_at: new Date(BASE_TIME + 2).toISOString(),
          transition: {
            kind: "dispatch_started",
            owner_id: "original-owner",
            active_node_ids: []
          }
        });

        const commands: AppendRunTransitionInput[] = [];
        const ledger: RunLedgerPort = {
          preallocate: async (input) => await store.ledger.preallocate(input),
          appendTransition: async (input) => {
            commands.push(input);
            return await store.ledger.appendTransition(input);
          },
          get: async (runId) => await store.ledger.get(runId),
          listOrphanCandidates: async (input) =>
            await store.ledger.listOrphanCandidates(input)
        };
        let currentNow = BASE_TIME + 120_000;
        const leaseOptions = () => ({
          ledger,
          runId: RUN_ID,
          ownerId: RECOVERY_OWNER,
          now: () => currentNow,
          heartbeatIntervalMs: 1_000
        });
        const running = await ledger.get(RUN_ID);
        if (running === undefined) throw new Error("Expected a running record");

        const firstLease = new NativeStudioRunLease(leaseOptions());
        await firstLease.claimRecovery(
          recoveryClaim(
            running,
            new Date(currentNow - 3_000).toISOString()
          )
        );
        firstLease.startHeartbeat();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(firstLease.hasHeartbeatFailure()).toBe(false);
        const simulatedOutboxFailure = new Error("terminal outbox unavailable");
        await expect(
          firstLease.commitTerminal(
            { status: "failed", cause: new Error("runtime failed") },
            { completeness: "partial" },
            async () => {
              throw simulatedOutboxFailure;
            }
          )
        ).rejects.toBe(simulatedOutboxFailure);

        const afterFirst = await ledger.get(RUN_ID);
        if (afterFirst?.heartbeat_at === undefined) {
          throw new Error("Expected the first recovery lease heartbeat");
        }
        currentNow = Date.parse(afterFirst.heartbeat_at) + 120_000;

        const secondLease = new NativeStudioRunLease(leaseOptions());
        await secondLease.claimRecovery(
          recoveryClaim(
            afterFirst,
            new Date(currentNow - 3_000).toISOString()
          )
        );
        secondLease.startHeartbeat();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(secondLease.hasHeartbeatFailure()).toBe(false);
        await secondLease.commitTerminal(
          { status: "failed", cause: new Error("runtime failed") },
          { completeness: "partial" },
          async (preparation) => {
            await ledger.appendTransition(preparation.command);
          }
        );

        const mutableCommands = commands.filter(
          (command) =>
            command.transition_id.startsWith("heartbeat-") ||
            command.transition_id.startsWith("terminal-lease-")
        );
        expect(mutableCommands.map((command) => command.transition_id)).toEqual([
          expect.stringMatching(/^heartbeat-[a-f0-9]{32}-1$/),
          expect.stringMatching(/^terminal-lease-[a-f0-9]{32}-2$/),
          expect.stringMatching(/^heartbeat-[a-f0-9]{32}-1$/),
          expect.stringMatching(/^terminal-lease-[a-f0-9]{32}-2$/)
        ]);
        expect(
          new Set(mutableCommands.map((command) => command.transition_id)).size
        ).toBe(4);
        for (const command of mutableCommands) {
          expect(command.event_id).toBe(`event-${command.transition_id}`);
          expect(command.transition_id.length).toBeLessThanOrEqual(256);
          expect(command.event_id.length).toBeLessThanOrEqual(256);
        }
        await expect(ledger.get(RUN_ID)).resolves.toMatchObject({
          run_status: "failed",
          owner_id: RECOVERY_OWNER
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
