import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeStudioDraftHash } from "../../../src/studio/application/drafts/change-set.js";
import {
  blob,
  createRepository,
  createRoot,
  DRAFT_ID,
  DRAFT_IDS,
  draftRoot,
  draftWithBlobs,
  seedDraft,
  versionOf
} from "./filesystem-draft-repository-test-support.js";

describe("filesystem Studio draft repository deletion and hardening", () => {
  it("uses a durable tombstone as the delete commit point", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-delete");
    const { draft } = await seedDraft(repository);

    await repository.delete({ draftId: DRAFT_ID, expectedVersion: versionOf(draft) });
    await expect(repository.get(DRAFT_ID)).resolves.toBeUndefined();
    await expect(repository.list()).resolves.toMatchObject({ items: [] });
    await expect(
      repository.delete({ draftId: DRAFT_ID, expectedVersion: versionOf(draft) })
    ).resolves.toBeUndefined();
    expect(
      (await readdir(path.join(root, ".luna", "studio", "drafts"))).some(
        (entry) => entry.startsWith(".deleted-")
      )
    ).toBe(true);
  });

  it("keeps tombstone version checks authoritative on delete retries", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-delete-version");
    const { draft } = await seedDraft(repository);
    const committedVersion = versionOf(draft);
    const mismatchedVersion = {
      ...committedVersion,
      recordRevision: committedVersion.recordRevision + 1
    };

    await repository.delete({
      draftId: DRAFT_ID,
      expectedVersion: committedVersion
    });
    await expect(
      repository.delete({
        draftId: DRAFT_ID,
        expectedVersion: mismatchedVersion
      })
    ).rejects.toMatchObject({
      code: "studio_draft_revision_conflict",
      details: {
        draftId: DRAFT_ID,
        expectedVersion: mismatchedVersion,
        actualVersion: committedVersion
      }
    });
  });

  for (const faultStage of [
    "after_delete_rename",
    "after_delete_directory_sync"
  ] as const) {
    it(`makes delete retryable after ${faultStage}`, async () => {
      const root = await createRoot();
      let injected = false;
      const repository = createRepository(root, `studio-${faultStage}`, {
        deleteFaultInjector: (stage) => {
          if (stage === faultStage && !injected) {
            injected = true;
            throw new Error(`injected ${stage}`);
          }
        }
      });
      const { draft } = await seedDraft(repository);
      const command = { draftId: DRAFT_ID, expectedVersion: versionOf(draft) };

      await expect(repository.delete(command)).rejects.toMatchObject({
        code: "studio_storage_commit_ambiguous"
      });
      await expect(repository.delete(command)).resolves.toBeUndefined();
      await expect(repository.get(DRAFT_ID)).resolves.toBeUndefined();
    });
  }

  it("collects expired delete tombstones on the next locked access", async () => {
    const root = await createRoot();
    let nowMs = Date.now();
    const repository = createRepository(root, "studio-delete-gc", {
      now: () => nowMs,
      limits: { deleteTombstoneRetentionMs: 10 }
    });
    const { draft } = await seedDraft(repository);
    await repository.delete({ draftId: DRAFT_ID, expectedVersion: versionOf(draft) });
    const draftsRoot = path.join(root, ".luna", "studio", "drafts");
    const tombstone = (await readdir(draftsRoot)).find((entry) =>
      entry.startsWith(".deleted-")
    )!;
    nowMs = Math.ceil((await stat(path.join(draftsRoot, tombstone))).mtimeMs) + 11;
    await repository.list();
    expect(
      (await readdir(draftsRoot)).some(
        (entry) => entry.startsWith(".deleted-")
      )
    ).toBe(true);
    await seedDraft(repository, DRAFT_IDS[1]);
    expect(
      (await readdir(draftsRoot)).some(
        (entry) => entry.startsWith(".deleted-")
      )
    ).toBe(false);
  });

  it("reschedules a non-expired tombstone and permits id reuse after expiry", async () => {
    const root = await createRoot();
    let nowMs = 10_000;
    const repository = createRepository(root, "studio-delete-scheduled-gc", {
      now: () => nowMs,
      limits: { deleteTombstoneRetentionMs: 10 }
    });
    const { draft } = await seedDraft(repository);
    await repository.delete({
      draftId: DRAFT_ID,
      expectedVersion: versionOf(draft)
    });

    nowMs += 5;
    await expect(repository.get(DRAFT_IDS[1])).resolves.toBeUndefined();
    const draftsRoot = path.join(root, ".luna", "studio", "drafts");
    expect(
      (await readdir(draftsRoot)).some((entry) =>
        entry.startsWith(".deleted-")
      )
    ).toBe(true);

    nowMs += 5;
    await expect(repository.get(DRAFT_IDS[1])).resolves.toBeUndefined();
    expect(
      (await readdir(draftsRoot)).some((entry) =>
        entry.startsWith(".deleted-")
      )
    ).toBe(false);
    await expect(seedDraft(repository, DRAFT_ID)).resolves.toMatchObject({
      draft: { draft_id: DRAFT_ID }
    });
  });

  it("periodically discovers tombstones created by another repository instance", async () => {
    const root = await createRoot();
    let nowMs = 20_000;
    const limits = { deleteTombstoneRetentionMs: 10 } as const;
    const first = createRepository(root, "studio-periodic-gc-first", {
      now: () => nowMs,
      limits
    });
    const second = createRepository(root, "studio-periodic-gc-second", {
      now: () => nowMs,
      limits
    });

    await expect(first.get(DRAFT_IDS[1])).resolves.toBeUndefined();
    const { draft } = await seedDraft(second);
    await second.delete({
      draftId: DRAFT_ID,
      expectedVersion: versionOf(draft)
    });
    const draftsRoot = path.join(root, ".luna", "studio", "drafts");
    expect(
      (await readdir(draftsRoot)).some((entry) =>
        entry.startsWith(".deleted-")
      )
    ).toBe(true);

    nowMs += 10;
    await expect(first.get(DRAFT_IDS[1])).resolves.toBeUndefined();
    expect(
      (await readdir(draftsRoot)).some((entry) =>
        entry.startsWith(".deleted-")
      )
    ).toBe(false);
    await expect(seedDraft(first, DRAFT_ID)).resolves.toMatchObject({
      draft: { draft_id: DRAFT_ID }
    });
  });

  it("refuses a draft directory symlink instead of reading outside storage", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const repository = createRepository(root, "studio-symlink");
    await repository.list();
    await mkdir(path.join(outside, "files"), { mode: 0o700 });
    await chmod(outside, 0o700);
    await symlink(outside, draftRoot(root), "dir");

    await expect(repository.get(DRAFT_ID)).rejects.toMatchObject({
      code: "studio_storage_invalid"
    });
  });

  it("reports a hash-valid domain-invalid draft without accepting it", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-domain-invalid");
    const baseBlob = blob("base");
    const changeBlob = blob("change");
    const draft = draftWithBlobs({
      baseDigest: baseBlob.digest,
      changeDigest: changeBlob.digest
    });
    const duplicateResource = {
      ...draft,
      resources: [...draft.resources, draft.resources[0]!]
    };
    const invalidDraft = {
      ...duplicateResource,
      draft_hash: computeStudioDraftHash(duplicateResource)
    };
    await expect(
      repository.create({
        changeSet: invalidDraft,
        blobs: [baseBlob, changeBlob]
      })
    ).rejects.toMatchObject({ code: "studio_draft_invalid" });
  });

  it("keeps stored metadata readable as JSON for recovery tools", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-readable-metadata");
    const { draft } = await seedDraft(repository);
    const stored = JSON.parse(
      await readFile(path.join(draftRoot(root), "change-set.json"), "utf8")
    ) as unknown;
    expect(stored).toEqual(draft);
  });
});
