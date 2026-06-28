import { describe, expect, it } from "vitest";
import type {
  ArtifactContentCommitInput,
  ArtifactContentWriteInput,
  ArtifactTransactionJournal,
  ArtifactTransactionRecord
} from "../../../src/core/runtime/artifacts/transaction.js";
import type {
  ArtifactManifest,
  ArtifactManifestKey
} from "../../../src/core/runtime/artifacts/contracts.js";
import {
  publishArtifactTransaction
} from "../../../src/core/runtime/artifacts/transaction.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";

function journal(): ArtifactTransactionJournal {
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

function contentStore() {
  const writes: string[] = [];
  const commits: string[] = [];
  return {
    writes,
    commits,
    store: {
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
    }
  };
}

function customUriContentStore(uriFor: (input: ArtifactContentCommitInput) => string) {
  return {
    store: {
      async write(input: ArtifactContentWriteInput) {
        return {
          pending_uri: `pending://${input.transaction_id}`,
          content_hash: input.content_hash
        };
      },
      async commit(input: ArtifactContentCommitInput) {
        return {
          uri: uriFor(input),
          content_hash: input.content_hash
        };
      }
    }
  };
}

function baseInput() {
  const content = contentStore();
  const checkpointed: string[] = [];
  return {
    content,
    input: {
      run_id: "run-1",
      node_id: "writer",
      artifact_id: "artifact-1",
      artifact_path: "reports/result.json",
      content: "{\"ok\":true}\n",
      media_type: "application/json",
      overwrite_policy: "forbid" as const,
      backend: { id: "memory.artifacts", root: "artifacts" },
      manifestStore: createMemoryArtifactManifestStore(),
      transactionJournal: journal(),
      contentStore: content.store,
      stepsPublisher: {
        async publishArtifactRef() {}
      },
      checkpointMarker: {
        async markArtifactCheckpointed(ref: ArtifactManifest) {
          checkpointed.push(ref.id);
        }
      },
      now: () => "2026-06-26T00:00:00.000Z"
    },
    checkpointed
  };
}

function manifestKey(overrides: Partial<ArtifactManifestKey> = {}): ArtifactManifestKey {
  return {
    id: "artifact-1",
    run_id: "run-1",
    source_node_id: "writer",
    artifact_path: "reports/result.json",
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

describe("artifact transaction", () => {
  it("publishes artifacts through pending manifest, content write, commit, manifest update, step marker, and checkpoint marker", async () => {
    const { input, checkpointed } = baseInput();

    const result = await publishArtifactTransaction(input);

    expect(result.manifest).toMatchObject({
      id: "artifact-1",
      run_id: "run-1",
      uri: artifactUri("reports/result.json"),
      source_node_id: "writer",
      media_type: "application/json",
      status: "committed",
      attempt: 1,
      content_hash: expect.stringMatching(/^sha256:/)
    });
    await expect(input.manifestStore.get(manifestKey())).resolves.toMatchObject({
      id: "artifact-1",
      content_hash: result.manifest.content_hash
    });
    expect(checkpointed).toEqual(["artifact-1"]);
  });

  it("rejects unsafe traversal and absolute artifact paths before content writes", async () => {
    for (const artifactPath of ["../escape.json", "/tmp/escape.json"]) {
      const { input, content } = baseInput();
      await expect(
        publishArtifactTransaction({
          ...input,
          artifact_path: artifactPath
        })
      ).rejects.toMatchObject({ code: "path_security_violation" });
      expect(content.writes).toEqual([]);
    }
  });

  it("requires explicit overwrite policy from artifact or backend", async () => {
    const { input } = baseInput();

    await expect(
      publishArtifactTransaction({
        ...input,
        overwrite_policy: undefined,
        backend: { id: "memory.artifacts", root: "artifacts" }
      })
    ).rejects.toMatchObject({ code: "artifact_overwrite_policy_required" });
  });

  it("does not duplicate replayed committed artifacts with the same content", async () => {
    const { input, content } = baseInput();

    const first = await publishArtifactTransaction(input);
    const second = await publishArtifactTransaction(input);

    expect(second.replayed).toBe(true);
    expect(second.manifest).toEqual(first.manifest);
    expect(content.writes).toEqual(["artifact-1"]);
    expect(content.commits).toEqual(["artifact-1"]);
  });

  it("rejects same artifact id with different content unless overwrite is explicit", async () => {
    const { input } = baseInput();

    const first = await publishArtifactTransaction(input);
    await expect(
      publishArtifactTransaction({
        ...input,
        content: "{\"ok\":false}\n"
      })
    ).rejects.toMatchObject({ code: "artifact_content_conflict" });

    const replaced = await publishArtifactTransaction({
      ...input,
      content: "{\"ok\":false}\n",
      overwrite_policy: "replace"
    });
    expect(replaced.manifest.id).toBe("artifact-1");
    expect(replaced.manifest.content_hash).not.toBe(first.manifest.content_hash);
  });

  it("does not adopt a committed artifact from a different attempt", async () => {
    const { input, content } = baseInput();

    const first = await publishArtifactTransaction(input);
    const second = await publishArtifactTransaction({
      ...input,
      attempt: 2,
      overwrite_policy: "replace"
    });

    expect(first.record.attempt).toBe(1);
    expect(second.record.attempt).toBe(2);
    expect(content.writes).toEqual(["artifact-1", "artifact-1"]);
    expect(content.commits).toEqual(["artifact-1", "artifact-1"]);
  });

  it("replays committed artifacts with backend-owned uri schemes", async () => {
    const customContent = customUriContentStore(
      (input) => `custom-store://${input.run_id}/${input.artifact_path}`
    );
    const { input } = baseInput();
    input.contentStore = customContent.store;
    input.backend = { id: "custom.artifacts", root: "custom-root" };

    const first = await publishArtifactTransaction(input);
    const second = await publishArtifactTransaction(input);

    expect(first.manifest.uri).toBe("custom-store://run-1/reports/result.json");
    expect(second.replayed).toBe(true);
  });
});
