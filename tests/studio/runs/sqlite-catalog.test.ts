import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { preallocation, withRunStore } from "./helpers.js";

async function allocateRuns(
  store: Parameters<Parameters<typeof withRunStore>[0]>[0]["store"],
  ids: readonly string[]
): Promise<void> {
  for (const [index, id] of ids.entries()) {
    await store.ledger.preallocate(preallocation(id, {
      created_at: index < 3
        ? "2026-07-10T12:00:00.000Z"
        : `2026-07-10T12:00:0${index}.000Z`,
      workflow_id: index % 2 === 0 ? "code-review" : "implementation",
      source: index % 2 === 0 ? "github" : "jira",
      correlation_id: index === 2 ? "shared-correlation" : `correlation-${id}`,
      job_id: index === 3 ? "special-job" : `job-${id}`
    }));
  }
}

describe("SQLite run catalog", () => {
  it("paginates with a stable timestamp/run-id tie break and snapshot", async () => {
    await withRunStore(async ({ store }) => {
      await allocateRuns(store, ["run-a", "run-b", "run-c", "run-d", "run-e"]);
      const first = await store.catalog.list({ direction: "asc", limit: 2 });
      expect(first.items.map((item) => item.run_id)).toEqual(["run-a", "run-b"]);
      expect(first.next_cursor).not.toBeNull();

      await store.ledger.preallocate(preallocation("run-new", {
        created_at: "2026-07-10T12:00:00.000Z"
      }));
      await store.ledger.appendTransition({
        run_id: "run-c",
        transition_id: "prepare-run-c",
        event_id: "event-prepare-run-c",
        expected_revision: 1,
        occurred_at: "2026-07-10T12:00:01.000Z",
        transition: { kind: "dispatch_preparing", owner_id: "worker-1" }
      });

      const second = await store.catalog.list({
        direction: "asc",
        limit: 2,
        cursor: first.next_cursor ?? undefined
      });
      const third = await store.catalog.list({
        direction: "asc",
        limit: 2,
        cursor: second.next_cursor ?? undefined
      });
      const snapshotItems = [...first.items, ...second.items, ...third.items];
      expect(snapshotItems.map((item) => item.run_id)).toEqual([
        "run-a", "run-b", "run-c", "run-d", "run-e"
      ]);
      expect(snapshotItems.find((item) => item.run_id === "run-c")?.status)
        .toBe("queued");
      expect(second.as_of).toBe(first.as_of);

      const current = await store.catalog.get("run-c");
      expect(current?.status).toBe("preparing");
      const fresh = await store.catalog.list({ direction: "asc", limit: 20 });
      expect(fresh.items.map((item) => item.run_id)).toContain("run-new");
    });
  });

  it("binds signed cursors to filters and direction and detects tampering", async () => {
    await withRunStore(async ({ store }) => {
      await allocateRuns(store, ["run-a", "run-b", "run-c"]);
      const first = await store.catalog.list({
        filters: { source: "github" },
        direction: "asc",
        limit: 1
      });
      const cursor = first.next_cursor;
      expect(cursor).not.toBeNull();
      if (cursor === null) {
        throw new Error("Expected cursor");
      }

      await expect(store.catalog.list({
        filters: { source: "jira" },
        direction: "asc",
        limit: 1,
        cursor
      })).rejects.toMatchObject({ code: "run_cursor_invalid" });
      await expect(store.catalog.list({
        filters: { source: "github" },
        direction: "desc",
        limit: 1,
        cursor
      })).rejects.toMatchObject({ code: "run_cursor_invalid" });

      const finalCharacter = cursor.endsWith("A") ? "B" : "A";
      const tampered = `${cursor.slice(0, -1)}${finalCharacter}`;
      await expect(store.catalog.list({
        filters: { source: "github" },
        direction: "asc",
        limit: 1,
        cursor: tampered
      })).rejects.toMatchObject({ code: "run_cursor_tampered" });
    });
  });

  it("expires cursors instead of retaining catalog snapshots forever", async () => {
    let now = new Date("2026-07-10T12:00:00.000Z");
    await withRunStore(async ({ store }) => {
      await allocateRuns(store, ["run-a", "run-b"]);
      const first = await store.catalog.list({ direction: "asc", limit: 1 });
      expect(first.next_cursor).not.toBeNull();
      now = new Date("2026-07-10T12:16:00.000Z");
      await expect(store.catalog.list({
        direction: "asc",
        limit: 1,
        cursor: first.next_cursor ?? undefined
      })).rejects.toMatchObject({ code: "run_cursor_expired" });
    }, { now: () => now });
  });

  it("rebuilds the catalog from canonical ledger records and invalidates old snapshots", async () => {
    await withRunStore(async ({ store }) => {
      await allocateRuns(store, ["run-a", "run-b"]);
      const before = await store.catalog.list({ direction: "asc", limit: 1 });
      expect(before.next_cursor).not.toBeNull();

      await expect(store.projector.rebuild()).resolves.toBe(2);
      const rebuilt = await store.catalog.list({ direction: "asc", limit: 10 });
      expect(rebuilt.items.map((item) => item.run_id)).toEqual(["run-a", "run-b"]);
      await expect(store.catalog.list({
        direction: "asc",
        limit: 1,
        cursor: before.next_cursor ?? undefined
      })).rejects.toMatchObject({ code: "run_cursor_invalid" });
    });
  });

  it("retains history for live cursors but compacts closed versions after retention", async () => {
    let now = new Date("2026-07-10T12:00:00.000Z");
    await withRunStore(async ({ filePath, store }) => {
      await store.ledger.preallocate(preallocation("run-a"));
      now = new Date("2026-07-10T12:01:00.000Z");
      await store.ledger.appendTransition({
        run_id: "run-a",
        transition_id: "prepare-a",
        event_id: "event-prepare-a",
        expected_revision: 1,
        occurred_at: now.toISOString(),
        transition: { kind: "dispatch_preparing", owner_id: "worker-1" }
      });
      now = new Date("2026-07-10T13:02:00.000Z");
      await store.catalog.list();

      const database = new DatabaseSync(filePath, { readOnly: true });
      try {
        const row = database.prepare(`
          SELECT COUNT(*) AS count
          FROM studio_run_catalog_versions
          WHERE run_id = 'run-a'
        `).get() as { count: number };
        expect(row.count).toBe(1);
      } finally {
        database.close();
      }
    }, { now: () => now });
  });

  it("uses indexed workflow, status, source, time, correlation, and job filters", async () => {
    await withRunStore(async ({ store }) => {
      await allocateRuns(store, ["run-a", "run-b", "run-c", "run-d", "run-e"]);
      await store.ledger.appendTransition({
        run_id: "run-a",
        transition_id: "prepare-a",
        event_id: "event-prepare-a",
        expected_revision: 1,
        occurred_at: "2026-07-10T12:00:01.000Z",
        transition: { kind: "dispatch_preparing", owner_id: "worker-1" }
      });

      const workflow = await store.catalog.list({
        filters: { workflow_id: "implementation" }
      });
      expect(workflow.items.map((item) => item.run_id).sort()).toEqual([
        "run-b", "run-d"
      ]);
      const status = await store.catalog.list({ filters: { statuses: ["preparing"] } });
      expect(status.items.map((item) => item.run_id)).toEqual(["run-a"]);
      const source = await store.catalog.list({ filters: { source: "jira" } });
      expect(source.items).toHaveLength(2);
      const correlation = await store.catalog.list({
        filters: { correlation_id: "shared-correlation" }
      });
      expect(correlation.items.map((item) => item.run_id)).toEqual(["run-c"]);
      const job = await store.catalog.list({ filters: { job_id: "special-job" } });
      expect(job.items.map((item) => item.run_id)).toEqual(["run-d"]);
      const time = await store.catalog.list({
        filters: {
          created_from: "2026-07-10T12:00:03.000Z",
          created_to: "2026-07-10T12:00:04.000Z"
        }
      });
      expect(time.items.map((item) => item.run_id).sort()).toEqual([
        "run-d", "run-e"
      ]);
    });
  });

  it("orders and filters timestamps by instant rather than offset text", async () => {
    await withRunStore(async ({ store }) => {
      await store.ledger.preallocate(preallocation("later-offset", {
        created_at: "2026-07-10T10:00:00.000-03:00"
      }));
      await store.ledger.preallocate(preallocation("earlier-utc", {
        created_at: "2026-07-10T12:30:00.000Z"
      }));

      const ordered = await store.catalog.list({ direction: "asc" });
      expect(ordered.items.map((item) => item.run_id)).toEqual([
        "earlier-utc", "later-offset"
      ]);
      const filtered = await store.catalog.list({
        filters: { created_from: "2026-07-10T12:45:00.000Z" }
      });
      expect(filtered.items.map((item) => item.run_id)).toEqual(["later-offset"]);
    });
  });

  it("keeps event pages ordered and excludes events appended after the cursor snapshot", async () => {
    await withRunStore(async ({ store }) => {
      await store.ledger.preallocate(preallocation("run-1"));
      for (let index = 2; index <= 5; index += 1) {
        await store.events.append({
          run_id: "run-1",
          event_id: `node-event-${index}`,
          expected_last_sequence: index - 1,
          event_type: index % 2 === 0 ? "node.started" : "node.finished",
          occurred_at: `2026-07-10T12:00:0${index}.000Z`,
          data: { index }
        });
      }
      const first = await store.events.list({
        run_id: "run-1",
        direction: "asc",
        event_types: ["node.started", "node.finished"],
        limit: 2
      });
      expect(first.items.map((event) => event.sequence)).toEqual([2, 3]);
      expect(first.as_of_sequence).toBe(5);

      await store.events.append({
        run_id: "run-1",
        event_id: "node-event-6",
        expected_last_sequence: 5,
        event_type: "node.started",
        occurred_at: "2026-07-10T12:00:06.000Z",
        data: { index: 6 }
      });
      const second = await store.events.list({
        run_id: "run-1",
        direction: "asc",
        event_types: ["node.started", "node.finished"],
        limit: 2,
        cursor: first.next_cursor ?? undefined
      });
      expect(second.items.map((event) => event.sequence)).toEqual([4, 5]);
      expect(second.as_of_sequence).toBe(5);
      expect(second.next_cursor).toBeNull();

      if (first.next_cursor === null) {
        throw new Error("Expected event cursor");
      }
      await expect(store.events.list({
        run_id: "run-1",
        direction: "desc",
        event_types: ["node.started", "node.finished"],
        limit: 2,
        cursor: first.next_cursor
      })).rejects.toMatchObject({ code: "run_cursor_invalid" });
      await expect(store.events.list({
        run_id: "run-1",
        direction: "asc",
        event_types: ["node.started"],
        limit: 2,
        cursor: first.next_cursor
      })).rejects.toMatchObject({ code: "run_cursor_invalid" });

      const fresh = await store.events.list({
        run_id: "run-1",
        direction: "desc",
        limit: 2
      });
      expect(fresh.items.map((event) => event.sequence)).toEqual([6, 5]);
    });
  });
});
