import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  startNodeAttempt,
  succeedNode
} from "../../../src/core/runtime/lifecycle.js";
import { createInitialRuntimeState } from "../../../src/core/runtime/state.js";
import type { CompiledWorkflow } from "../../../src/core/workflow/compiler.js";
import { sha256Digest } from "../../../src/core/workflow/definition-digests.js";
import {
  FilesystemRunGraphStore,
  MAX_STORED_RUN_GRAPH_BYTES,
  MAX_STORED_RUN_OUTCOME_BYTES
} from "../../../src/studio/adapters/filesystem/run-graph-store.js";
import {
  projectStoredRunGraphOutcome,
  projectStoredRunGraphSnapshot,
  type RunGraphSnapshotIdentity,
  type StoredRunGraphOutcome
} from "../../../src/studio/application/runs/graph-snapshot.js";
import { DIGEST_A, DIGEST_B, DIGEST_D } from "./helpers.js";

const HANDLE = `gs_${"A".repeat(22)}`;
const HANDLE_B = `gs_${"B".repeat(22)}`;
const HANDLE_C = `gs_${"C".repeat(22)}`;

function identity(
  overrides: Partial<RunGraphSnapshotIdentity> = {}
): RunGraphSnapshotIdentity {
  return {
    graph_snapshot_handle: HANDLE,
    run_id: "run-store-1",
    workflow_id: "code-review",
    workflow_revision: DIGEST_A,
    definition_bundle_hash: DIGEST_B,
    execution_snapshot_hash: DIGEST_D,
    ...overrides
  };
}

function compiled(capabilityId = "agents"): CompiledWorkflow {
  return {
    workflow_id: "code-review",
    workflow_revision: DIGEST_A,
    state_schema_version: "2026-06",
    nodes: [
      {
        id: "review",
        kind: "agent",
        yaml_path: "$.graph.nodes[0]",
        capability_id: capabilityId,
        output_schema: {},
        can_create_pending_interrupt: false,
        source: {}
      }
    ],
    edges: [],
    state: { channels: {} }
  } as unknown as CompiledWorkflow;
}

function snapshot(overrides: Partial<RunGraphSnapshotIdentity> = {}) {
  return projectStoredRunGraphSnapshot({
    identity: identity(overrides),
    compiled: compiled()
  });
}

function outcome(graph = snapshot(), recordRevision = 4) {
  let state = createInitialRuntimeState({
    invocation: { private: "invocation" },
    config: { private: "config" },
    run: {
      run_id: graph.identity.run_id,
      workflow_id: graph.identity.workflow_id,
      attempt: 1,
      started_at: "2026-07-11T10:00:00.000Z"
    },
    workflow: { id: graph.identity.workflow_id }
  });
  state = startNodeAttempt(state, "review", 1);
  state = succeedNode(state, "review");
  state = { ...state, run_status: "succeeded" };
  return projectStoredRunGraphOutcome({
    graphSnapshot: graph,
    recordRevision,
    state
  });
}

async function withStore(
  operation: (context: {
    root: string;
    store: FilesystemRunGraphStore;
  }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-run-graphs-"));
  const store = new FilesystemRunGraphStore({ root });
  try {
    await operation({ root, store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function rehashOutcome(
  current: StoredRunGraphOutcome,
  overrides: Partial<Omit<StoredRunGraphOutcome, "outcome_hash">>
): StoredRunGraphOutcome {
  const material = {
    schema_version: current.schema_version,
    identity: current.identity,
    graph_hash: current.graph_hash,
    record_revision: current.record_revision,
    run_status: current.run_status,
    nodes: current.nodes,
    ...overrides
  };
  return { ...material, outcome_hash: sha256Digest(material) };
}

describe("filesystem run graph store", () => {
  it("writes immutable graph and outcome snapshots idempotently", async () => {
    await withStore(async ({ store }) => {
      const graph = snapshot();
      const finalOutcome = outcome(graph);
      await store.writeGraph(graph);
      await store.writeGraph(graph);
      await store.writeOutcome(finalOutcome);
      await store.writeOutcome(finalOutcome);

      expect(await store.readGraph(HANDLE)).toEqual({
        kind: "available",
        value: graph
      });
      expect(await store.readOutcome(HANDLE)).toEqual({
        kind: "available",
        value: finalOutcome
      });

      await expect(
        store.writeGraph(
          projectStoredRunGraphSnapshot({
            identity: identity(),
            compiled: compiled("different.capability")
          })
        )
      ).rejects.toMatchObject({ code: "run_graph_store_write_failed" });
      await expect(store.writeOutcome(outcome(graph, 5))).rejects.toMatchObject({
        code: "run_graph_store_write_failed"
      });
    });
  });

  it("rejects traversal, symlinked storage and oversized graph files", async () => {
    await withStore(async ({ root, store }) => {
      await store.initialize();
      expect(await store.readGraph("../private-job")).toEqual({ kind: "corrupt" });

      const external = path.join(root, "external");
      await mkdir(external);
      await writeFile(path.join(external, "graph.json"), "{}", "utf8");
      await symlink(external, path.join(root, "snapshots", HANDLE), "dir");
      expect(await store.readGraph(HANDLE)).toEqual({ kind: "corrupt" });

      const oversizedDirectory = path.join(root, "snapshots", HANDLE_B);
      await mkdir(oversizedDirectory);
      const oversizedPath = path.join(oversizedDirectory, "graph.json");
      await writeFile(oversizedPath, "{}", "utf8");
      await truncate(oversizedPath, MAX_STORED_RUN_GRAPH_BYTES + 1);
      expect(await store.readGraph(HANDLE_B)).toEqual({ kind: "corrupt" });
    });
  });

  it("detects graph digest tampering", async () => {
    await withStore(async ({ root, store }) => {
      await store.writeGraph(snapshot());
      const filePath = path.join(root, "snapshots", HANDLE, "graph.json");
      const raw = await readFile(filePath, "utf8");
      await writeFile(filePath, raw.replace('"capability_id":"agents"', '"capability_id":"tampered"'));

      expect(await store.readGraph(HANDLE)).toEqual({ kind: "corrupt" });
    });
  });

  it("rejects outcomes bound to another run or unknown graph nodes", async () => {
    await withStore(async ({ store }) => {
      const graph = snapshot();
      await store.writeGraph(graph);
      const valid = outcome(graph);
      const wrongRun = rehashOutcome(valid, {
        identity: { ...valid.identity, run_id: "run-store-other" }
      });
      const unknownNode = rehashOutcome(valid, {
        nodes: [{ node_id: "intruder", status: "succeeded", attempt_count: 1 }]
      });

      await expect(store.writeOutcome(wrongRun)).rejects.toMatchObject({
        code: "run_graph_store_write_failed"
      });
      await expect(store.writeOutcome(unknownNode)).rejects.toMatchObject({
        code: "run_graph_store_write_failed"
      });
    });
  });

  it("degrades corrupt statuses and oversized outcomes without parsing them", async () => {
    await withStore(async ({ root, store }) => {
      const graph = snapshot({
        graph_snapshot_handle: HANDLE_C,
        run_id: "run-store-3"
      });
      await store.writeGraph(graph);
      const outcomePath = path.join(
        root,
        "snapshots",
        HANDLE_C,
        "outcome.json"
      );
      await writeFile(
        outcomePath,
        JSON.stringify({ ...outcome(graph), nodes: [{ node_id: "review", status: "future" }] }),
        "utf8"
      );
      expect(await store.readOutcome(HANDLE_C)).toEqual({ kind: "corrupt" });

      await truncate(outcomePath, MAX_STORED_RUN_OUTCOME_BYTES + 1);
      expect(await store.readOutcome(HANDLE_C)).toEqual({ kind: "corrupt" });
    });
  });
});
