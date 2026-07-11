import { describe, expect, it } from "vitest";
import { createSqliteRunStore } from "../../../src/studio/adapters/sqlite/run-store.js";
import { RunStoreError } from "../../../src/studio/application/runs/errors.js";
import { preallocation, withRunStore } from "./helpers.js";

describe("SQLite run ledger", () => {
  it("preallocates queued before dispatch and retries idempotently", async () => {
    await withRunStore(async ({ store }) => {
      const command = preallocation("run-1");
      const first = await store.ledger.preallocate(command);
      const retry = await store.ledger.preallocate(command);

      expect(first).toMatchObject({ applied: true, transition_revision: 1 });
      expect(first.record.dispatch_status).toBe("queued");
      expect(retry).toMatchObject({ applied: false, transition_revision: 1 });
      await expect(store.ledger.preallocate({
        ...command,
        source: "jira"
      })).rejects.toMatchObject({ code: "run_idempotency_conflict" });
    });
  });

  it("applies CAS transitions, validates owner, and freezes terminal lifecycle", async () => {
    await withRunStore(async ({ store }) => {
      await store.ledger.preallocate(preallocation("run-1"));
      const preparingCommand = {
        run_id: "run-1",
        transition_id: "prepare-1",
        event_id: "event-prepare-1",
        expected_revision: 1,
        occurred_at: "2026-07-10T12:00:01.000Z",
        transition: { kind: "dispatch_preparing" as const, owner_id: "worker-1" }
      };
      const preparing = await store.ledger.appendTransition(preparingCommand);
      const retry = await store.ledger.appendTransition({
        ...preparingCommand,
        expected_revision: 2
      });
      expect(preparing.record.record_revision).toBe(2);
      expect(retry).toMatchObject({ applied: false, transition_revision: 2 });

      await expect(store.ledger.appendTransition({
        ...preparingCommand,
        transition_id: "prepare-stale",
        event_id: "event-prepare-stale"
      })).rejects.toMatchObject({ code: "run_revision_conflict" });

      const started = await store.ledger.appendTransition({
        run_id: "run-1",
        transition_id: "start-1",
        event_id: "event-start-1",
        expected_revision: 2,
        occurred_at: "2026-07-10T12:00:02.000Z",
        transition: {
          kind: "dispatch_started",
          owner_id: "worker-1",
          active_node_ids: ["node-a"]
        }
      });
      expect(started.record.run_status).toBe("running");

      await expect(store.ledger.appendTransition({
        run_id: "run-1",
        transition_id: "heartbeat-wrong-owner",
        event_id: "event-heartbeat-wrong-owner",
        expected_revision: 3,
        occurred_at: "2026-07-10T12:00:03.000Z",
        transition: { kind: "heartbeat", owner_id: "worker-2" }
      })).rejects.toMatchObject({ code: "run_owner_conflict" });

      const terminal = await store.ledger.appendTransition({
        run_id: "run-1",
        transition_id: "succeed-1",
        event_id: "event-succeed-1",
        expected_revision: 3,
        occurred_at: "2026-07-10T12:00:12.000Z",
        transition: {
          kind: "runtime_status",
          owner_id: "worker-1",
          status: "succeeded",
          active_node_ids: []
        }
      });
      expect(terminal.record.finished_at).toBe("2026-07-10T12:00:12.000Z");
      await expect(store.ledger.appendTransition({
        run_id: "run-1",
        transition_id: "heartbeat-terminal",
        event_id: "event-heartbeat-terminal",
        expected_revision: 4,
        occurred_at: "2026-07-10T12:00:13.000Z",
        transition: { kind: "heartbeat", owner_id: "worker-1" }
      })).rejects.toMatchObject({ code: "run_terminal_immutable" });

      const detail = await store.catalog.get("run-1");
      expect(detail?.wall_duration_ms).toBe(10_000);
      expect(detail?.status).toBe("succeeded");
    });
  });

  it("appends events with sequence CAS and event-id idempotency", async () => {
    await withRunStore(async ({ store }) => {
      await store.ledger.preallocate(preallocation("run-1"));
      const command = {
        run_id: "run-1",
        event_id: "node-started-1",
        expected_last_sequence: 1,
        event_type: "node.started",
        occurred_at: "2026-07-10T12:00:00.500Z",
        data: { node_id: "node-a" }
      };
      const first = await store.events.append(command);
      const retry = await store.events.append({
        ...command,
        expected_last_sequence: 2
      });
      expect(first).toMatchObject({ applied: true, event: { sequence: 2 } });
      expect(retry).toMatchObject({ applied: false, event: { sequence: 2 } });

      await expect(store.events.append({
        ...command,
        event_id: "node-started-2"
      })).rejects.toMatchObject({ code: "run_event_sequence_conflict" });
      await expect(store.events.append({
        ...command,
        data: { node_id: "different" }
      })).rejects.toMatchObject({ code: "run_event_id_conflict" });
    });
  });

  it("keeps transition events time-ordered and bounds persisted JSON", async () => {
    await withRunStore(async ({ store }) => {
      await store.ledger.preallocate(preallocation("run-1"));
      await store.events.append({
        run_id: "run-1",
        event_id: "node-event-future",
        expected_last_sequence: 1,
        event_type: "node.started",
        occurred_at: "2026-07-10T12:00:10.000Z",
        data: { node_id: "node-a" }
      });
      await expect(store.ledger.appendTransition({
        run_id: "run-1",
        transition_id: "prepare-too-early",
        event_id: "event-prepare-too-early",
        expected_revision: 1,
        occurred_at: "2026-07-10T12:00:05.000Z",
        transition: { kind: "dispatch_preparing", owner_id: "worker-1" }
      })).rejects.toMatchObject({ code: "run_transition_invalid" });
      expect((await store.ledger.get("run-1"))?.record_revision).toBe(1);

      await expect(store.events.append({
        run_id: "run-1",
        event_id: "oversized-event",
        expected_last_sequence: 2,
        event_type: "node.output",
        occurred_at: "2026-07-10T12:00:11.000Z",
        data: { output: "x".repeat(300_000) }
      })).rejects.toMatchObject({ code: "run_invalid_input" });

      await expect(store.ledger.preallocate(preallocation("oversized-run", {
        side_effects: [{ description: "x".repeat(1_100_000) }]
      }))).rejects.toMatchObject({ code: "run_invalid_input" });
      expect(await store.ledger.get("oversized-run")).toBeUndefined();
    });
  });

  it("allows only one concurrent writer to win the same revision", async () => {
    await withRunStore(async ({ filePath, store: firstStore }) => {
      const secondStore = await createSqliteRunStore({ filePath });
      try {
        await firstStore.ledger.preallocate(preallocation("run-1"));
        const outcomes = await Promise.allSettled([
          firstStore.ledger.appendTransition({
            run_id: "run-1",
            transition_id: "prepare-a",
            event_id: "event-prepare-a",
            expected_revision: 1,
            occurred_at: "2026-07-10T12:00:01.000Z",
            transition: { kind: "dispatch_preparing", owner_id: "worker-a" }
          }),
          secondStore.ledger.appendTransition({
            run_id: "run-1",
            transition_id: "prepare-b",
            event_id: "event-prepare-b",
            expected_revision: 1,
            occurred_at: "2026-07-10T12:00:01.000Z",
            transition: { kind: "dispatch_preparing", owner_id: "worker-b" }
          })
        ]);

        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        const rejected = outcomes.find((outcome) => outcome.status === "rejected");
        expect(rejected).toBeDefined();
        if (rejected?.status === "rejected") {
          expect(rejected.reason).toBeInstanceOf(RunStoreError);
          expect(rejected.reason).toMatchObject({ code: "run_revision_conflict" });
        }
      } finally {
        secondStore.close();
      }
    });
  });

  it("finds stale active owners without treating terminal runs as orphaned", async () => {
    await withRunStore(async ({ store }) => {
      await store.ledger.preallocate(preallocation("active"));
      await store.ledger.appendTransition({
        run_id: "active",
        transition_id: "prepare-active",
        event_id: "event-prepare-active",
        expected_revision: 1,
        occurred_at: "2026-07-10T12:00:01.000Z",
        transition: { kind: "dispatch_preparing", owner_id: "worker-1" }
      });
      await store.ledger.preallocate(preallocation("rejected"));
      await store.ledger.appendTransition({
        run_id: "rejected",
        transition_id: "reject",
        event_id: "event-reject",
        expected_revision: 1,
        occurred_at: "2026-07-10T12:00:02.000Z",
        transition: {
          kind: "dispatch_rejected",
          failure: { code: "dispatch_failed", message: "Dispatcher refused work" }
        }
      });

      const candidates = await store.ledger.listOrphanCandidates({
        stale_before: "2026-07-10T12:01:00.000Z"
      });
      expect(candidates.map((candidate) => candidate.record.run_id)).toEqual(["active"]);
    });
  });
});
