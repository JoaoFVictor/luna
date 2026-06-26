import { describe, expect, it } from "vitest";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import type {
  ArtifactContentCommitInput,
  ArtifactContentWriteInput,
  ArtifactTransactionJournal,
  ArtifactTransactionRecord,
  ArtifactTransactionStage
} from "../../../src/core/runtime/artifacts/transaction.js";
import type {
  ArtifactManifest,
  ArtifactManifestKey
} from "../../../src/core/runtime/artifacts/contracts.js";
import {
  publishArtifactTransaction
} from "../../../src/core/runtime/artifacts/transaction.js";

function crashOnceJournal(stage: ArtifactTransactionStage): ArtifactTransactionJournal {
  const records = new Map<string, ArtifactTransactionRecord>();
  let crashed = false;
  return {
    async get(transactionId) {
      const record = records.get(transactionId);
      return record === undefined ? undefined : structuredClone(record);
    },
    async put(record) {
      records.set(record.transaction_id, structuredClone(record));
      if (!crashed && record.stage === stage) {
        crashed = true;
        throw Object.assign(new Error(`crashed after ${stage}`), {
          code: "simulated_crash"
        });
      }
    }
  };
}

function dropOnceJournal(stage: ArtifactTransactionStage): ArtifactTransactionJournal {
  const records = new Map<string, ArtifactTransactionRecord>();
  let dropped = false;
  return {
    async get(transactionId) {
      const record = records.get(transactionId);
      return record === undefined ? undefined : structuredClone(record);
    },
    async put(record) {
      if (!dropped && record.stage === stage) {
        dropped = true;
        throw Object.assign(new Error(`crashed before persisting ${stage}`), {
          code: "simulated_crash"
        });
      }
      records.set(record.transaction_id, structuredClone(record));
    }
  };
}

function durableJournal(): ArtifactTransactionJournal {
  const records = new Map<string, ArtifactTransactionRecord>();
  return {
    async get(transactionId) {
      const record = records.get(transactionId);
      return record === undefined ? undefined : structuredClone(record);
    },
    async put(record) {
      records.set(record.transaction_id, structuredClone(record));
    }
  };
}

function recoveryHarness(stage: ArtifactTransactionStage) {
  const writes: string[] = [];
  const commits: string[] = [];
  const stepMarkers: string[] = [];
  const checkpointMarkers: string[] = [];

  return {
    calls: { writes, commits, stepMarkers, checkpointMarkers },
    input: {
      run_id: "run-1",
      node_id: "writer",
      artifact_id: "artifact-1",
      artifact_path: "result.json",
      content: "stable content",
      overwrite_policy: "forbid" as const,
      backend: { id: "memory.artifacts", root: "artifacts" },
      manifestStore: createMemoryArtifactManifestStore(),
      transactionJournal: crashOnceJournal(stage),
      contentStore: {
        async write(input: ArtifactContentWriteInput) {
          writes.push(input.artifact_id);
          return {
            pending_uri: `pending://${input.transaction_id}`,
            content_hash: input.content_hash
          };
        },
        async commit(input: ArtifactContentCommitInput) {
          commits.push(input.artifact_id);
          return {
            uri: artifactUri(input.artifact_path),
            content_hash: input.content_hash
          };
        }
      },
      stepsPublisher: {
        async publishArtifactRef(ref: ArtifactManifest) {
          stepMarkers.push(ref.id);
        }
      },
      checkpointMarker: {
        async markArtifactCheckpointed(ref: ArtifactManifest) {
          checkpointMarkers.push(ref.id);
        }
      },
      now: () => "2026-06-26T00:00:00.000Z"
    }
  };
}

function manifestKey(overrides: Partial<ArtifactManifestKey> = {}): ArtifactManifestKey {
  return {
    id: "artifact-1",
    run_id: "run-1",
    source_node_id: "writer",
    artifact_path: "result.json",
    attempt: 1,
    backend_id: "memory.artifacts",
    backend_root: "artifacts",
    ...overrides
  };
}

function artifactUri(artifactPath: string, runId = "run-1"): string {
  const scheme = "artifact";
  return `${scheme}://${runId}/${artifactPath}`;
}

describe("artifact transaction crash recovery", () => {
  it.each([
    "pending_manifest_created",
    "content_written",
    "content_committed",
    "manifest_updated",
    "steps_published",
    "checkpoint_marked"
  ] as const)("recovers after a crash at %s", async (stage) => {
    const { input, calls } = recoveryHarness(stage);

    await expect(publishArtifactTransaction(input)).rejects.toMatchObject({
      code: "simulated_crash"
    });
    await expect(publishArtifactTransaction(input)).resolves.toMatchObject({
      record: { stage: "checkpoint_marked" },
      manifest: { id: "artifact-1" }
    });

    await expect(input.manifestStore.get(manifestKey())).resolves.toMatchObject({
      id: "artifact-1",
      uri: artifactUri("result.json")
    });
    expect(calls.writes.length).toBeLessThanOrEqual(1);
    expect(calls.commits.length).toBeLessThanOrEqual(1);
    expect(calls.stepMarkers).toEqual(["artifact-1"]);
    expect(calls.checkpointMarkers).toEqual(["artifact-1"]);
  });

  it("creates a durable namespaced pending manifest before content writes", async () => {
    const { input } = recoveryHarness("pending_manifest_created");

    await expect(publishArtifactTransaction(input)).rejects.toMatchObject({
      code: "simulated_crash"
    });
    await expect(input.manifestStore.get(manifestKey())).resolves.toBeUndefined();
    await expect(input.manifestStore.list("run-1")).resolves.toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^artifact-1:pending:/),
        artifact_path: expect.stringMatching(
          /^\.pending-artifact-transactions\/[a-f0-9]{64}\.json$/
        ),
        uri: expect.stringMatching(/^pending:\/\//),
        status: "pending",
        attempt: 1
      })
    ]);

    await expect(publishArtifactTransaction(input)).resolves.toMatchObject({
      manifest: { id: "artifact-1", status: "committed", attempt: 1 }
    });
    await expect(input.manifestStore.get(manifestKey())).resolves.toMatchObject({
      id: "artifact-1",
      uri: artifactUri("result.json"),
      status: "committed",
      attempt: 1
    });
  });

  it("keeps the committed manifest readable when replace crashes after pending manifest creation", async () => {
    const { input } = recoveryHarness("pending_manifest_created");
    input.transactionJournal = durableJournal();

    const first = await publishArtifactTransaction({
      ...input,
      content: "old committed content"
    });

    const replacementInput = {
      ...input,
      content: "replacement content",
      overwrite_policy: "replace" as const,
      transactionJournal: crashOnceJournal("pending_manifest_created")
    };

    await expect(publishArtifactTransaction(replacementInput)).rejects.toMatchObject({
      code: "simulated_crash"
    });
    await expect(input.manifestStore.get(manifestKey())).resolves.toMatchObject({
      id: "artifact-1",
      status: "committed",
      content_hash: first.manifest.content_hash,
      uri: first.manifest.uri
    });

    const replaced = await publishArtifactTransaction(replacementInput);

    expect(replaced.manifest.content_hash).not.toBe(first.manifest.content_hash);
    await expect(input.manifestStore.get(manifestKey())).resolves.toMatchObject({
      id: "artifact-1",
      status: "committed",
      content_hash: replaced.manifest.content_hash,
      uri: replaced.manifest.uri
    });
  });

  it("adopts a committed manifest when the manifest-updated journal write was lost", async () => {
    const { input, calls } = recoveryHarness("checkpoint_marked");
    input.transactionJournal = dropOnceJournal("manifest_updated");

    await expect(publishArtifactTransaction(input)).rejects.toMatchObject({
      code: "simulated_crash"
    });
    await expect(input.manifestStore.get(manifestKey())).resolves.toMatchObject({
      id: "artifact-1",
      status: "committed",
      attempt: 1
    });

    await expect(publishArtifactTransaction(input)).resolves.toMatchObject({
      record: { stage: "checkpoint_marked" },
      replayed: false
    });
    expect(calls.stepMarkers).toEqual(["artifact-1"]);
    expect(calls.checkpointMarkers).toEqual(["artifact-1"]);
  });
});
