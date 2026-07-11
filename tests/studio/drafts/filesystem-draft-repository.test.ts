import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  replaceStudioDraftContent,
  replaceStudioDraftLayout
} from "../../../src/studio/application/drafts/change-set.js";
import type { StudioDraftLockPort } from "../../../src/studio/application/drafts/persistence.js";
import {
  blob,
  createRepository,
  createRoot,
  DRAFT_ID,
  DRAFT_IDS,
  digestPath,
  draftRoot,
  draftWithBlobs,
  modeBits,
  rawDigest,
  seedDraft,
  versionOf
} from "./filesystem-draft-repository-test-support.js";

describe("filesystem Studio draft repository persistence", () => {
  it("persists a draft and its batch of UTF-8 blobs privately", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-private");
    const { draft, changeBlob } = await seedDraft(repository);

    await expect(repository.get(DRAFT_ID)).resolves.toEqual(draft);
    await expect(
      repository.getBlob(DRAFT_ID, changeBlob.digest, { maxBytes: 1_000 })
    ).resolves.toBe(changeBlob.content);
    await expect(
      repository.getBlob(DRAFT_ID, changeBlob.digest, {
        maxBytes: Buffer.byteLength(changeBlob.content, "utf8") - 1
      })
    ).rejects.toMatchObject({
      code: "studio_blob_too_large",
      details: {
        actualBytes: Buffer.byteLength(changeBlob.content, "utf8"),
        maxBytes: Buffer.byteLength(changeBlob.content, "utf8") - 1
      }
    });
    await expect(repository.list()).resolves.toMatchObject({
      items: [expect.objectContaining({ draft_id: DRAFT_ID })],
      diagnostics: [],
      next_cursor: null
    });

    const studioRoot = path.join(root, ".luna", "studio");
    expect(modeBits((await stat(studioRoot)).mode)).toBe(0o700);
    expect(modeBits((await stat(path.join(studioRoot, "drafts"))).mode)).toBe(
      0o700
    );
    expect(modeBits((await stat(draftRoot(root))).mode)).toBe(0o700);
    expect(
      modeBits((await stat(path.join(draftRoot(root), "files"))).mode)
    ).toBe(0o700);
    expect(
      modeBits((await stat(path.join(draftRoot(root), "change-set.json"))).mode)
    ).toBe(0o600);
    expect(
      modeBits((await stat(digestPath(root, DRAFT_ID, changeBlob.digest))).mode)
    ).toBe(0o600);
  });

  it("commits metadata and blobs as one create command", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-batch-create");
    const baseBlob = blob("base");
    const changeBlob = blob("change");
    const draft = draftWithBlobs({
      baseDigest: baseBlob.digest,
      changeDigest: changeBlob.digest
    });

    await expect(
      repository.create({ changeSet: draft, blobs: [baseBlob] })
    ).rejects.toMatchObject({
      code: "studio_blob_missing",
      details: { digest: changeBlob.digest }
    });
    await expect(repository.get(DRAFT_ID)).resolves.toBeUndefined();
    await expect(readdir(path.join(root, ".luna", "studio", "drafts"))).resolves
      .toEqual([]);
  });

  for (const faultStage of [
    "after_create_staging",
    "after_create_metadata"
  ] as const) {
    it(`keeps a pre-publish ${faultStage} failure retryable`, async () => {
      const root = await createRoot();
      let injected = false;
      const repository = createRepository(root, `studio-${faultStage}`, {
        createFaultInjector(stage) {
          if (stage === faultStage && !injected) {
            injected = true;
            throw new Error(`injected ${stage}`);
          }
        }
      });
      const baseBlob = blob("base");
      const changeBlob = blob("change");
      const draft = draftWithBlobs({
        baseDigest: baseBlob.digest,
        changeDigest: changeBlob.digest
      });
      const command = {
        changeSet: draft,
        blobs: [baseBlob, changeBlob]
      };

      await expect(repository.create(command)).rejects.toThrow(
        `injected ${faultStage}`
      );
      await expect(repository.get(DRAFT_ID)).resolves.toBeUndefined();
      await expect(
        readdir(path.join(root, ".luna", "studio", "drafts"))
      ).resolves.toEqual([]);
      await expect(repository.create(command)).resolves.toEqual(draft);
    });
  }

  for (const faultStage of [
    "after_create_rename",
    "after_create_directory_sync"
  ] as const) {
    it(`reports a post-publish ${faultStage} failure as ambiguous`, async () => {
      const root = await createRoot();
      let injected = false;
      const repository = createRepository(root, `studio-${faultStage}`, {
        createFaultInjector(stage) {
          if (stage === faultStage && !injected) {
            injected = true;
            throw new Error(`injected ${stage}`);
          }
        }
      });
      const baseBlob = blob("base");
      const changeBlob = blob("change");
      const draft = draftWithBlobs({
        baseDigest: baseBlob.digest,
        changeDigest: changeBlob.digest
      });
      const command = {
        changeSet: draft,
        blobs: [baseBlob, changeBlob]
      };

      await expect(repository.create(command)).rejects.toMatchObject({
        code: "studio_storage_commit_ambiguous"
      });
      await expect(repository.get(DRAFT_ID)).resolves.toEqual(draft);
      await expect(repository.create(command)).rejects.toMatchObject({
        code: "studio_draft_already_exists"
      });
    });
  }

  it("recovers a hidden staging directory left by a crashed creator", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-stale-staging");
    await repository.list();
    const staging = path.join(
      root,
      ".luna",
      "studio",
      "drafts",
      `.creating-${DRAFT_ID}`
    );
    await mkdir(path.join(staging, "files"), { recursive: true, mode: 0o700 });
    const baseBlob = blob("base");
    const changeBlob = blob("change");
    const draft = draftWithBlobs({
      baseDigest: baseBlob.digest,
      changeDigest: changeBlob.digest
    });

    await expect(
      repository.create({
        changeSet: draft,
        blobs: [baseBlob, changeBlob]
      })
    ).resolves.toEqual(draft);
    await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("collects orphan staging for another draft on the first non-list access", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-other-stale-staging");
    await repository.list();
    const staging = path.join(
      root,
      ".luna",
      "studio",
      "drafts",
      `.creating-${DRAFT_IDS[1]}`
    );
    await mkdir(path.join(staging, "files"), { recursive: true, mode: 0o700 });

    await expect(repository.list()).resolves.toMatchObject({ items: [] });
    await expect(stat(staging)).resolves.toMatchObject({});
    await expect(repository.get(DRAFT_ID)).resolves.toBeUndefined();
    await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a maintenance entry swap without touching its symlink target", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const outsideSentinel = path.join(outside, "must-survive.txt");
    await writeFile(outsideSentinel, "outside", "utf8");
    const staging = path.join(
      root,
      ".luna",
      "studio",
      "drafts",
      `.creating-${DRAFT_IDS[1]}`
    );
    let swapped = false;
    const repository = createRepository(root, "studio-maintenance-swap", {
      async rootMaintenanceFaultInjector(stage, context) {
        if (
          stage === "after_root_entry_inspected" &&
          context.entryPath === staging &&
          !swapped
        ) {
          swapped = true;
          await rm(staging, { recursive: true, force: true });
          await symlink(outside, staging, "dir");
        }
      }
    });
    await repository.list();
    await mkdir(path.join(staging, "files"), { recursive: true, mode: 0o700 });

    await expect(repository.get(DRAFT_ID)).rejects.toMatchObject({
      code: "studio_storage_invalid"
    });
    expect((await lstat(staging)).isSymbolicLink()).toBe(true);
    await expect(readFile(outsideSentinel, "utf8")).resolves.toBe("outside");
  });

  it("keeps committed outcomes authoritative when lock release reporting fails", async () => {
    const root = await createRoot();
    const releaseError = new Error("injected lock release failure");
    const notifications: Array<{
      readonly error: unknown;
      readonly operationSucceeded: boolean;
    }> = [];
    const lockManager: StudioDraftLockPort = {
      async acquire() {
        return async () => {
          throw releaseError;
        };
      }
    };
    const repository = createRepository(root, "studio-release-failure", {
      lockManager,
      onLockReleaseError(error, context) {
        notifications.push({
          error,
          operationSucceeded: context.operationSucceeded
        });
        return new Promise<void>(() => {
          // An audit sink may stall indefinitely; storage outcomes must not.
        });
      }
    });
    const baseBlob = blob("base");
    const changeBlob = blob("change");
    const draft = draftWithBlobs({
      baseDigest: baseBlob.digest,
      changeDigest: changeBlob.digest
    });
    const createCommand = {
      changeSet: draft,
      blobs: [baseBlob, changeBlob]
    };

    await expect(repository.create(createCommand)).resolves.toEqual(draft);
    await expect(repository.create(createCommand)).rejects.toMatchObject({
      code: "studio_draft_already_exists"
    });
    const updated = replaceStudioDraftLayout(
      draft,
      { selected: "node-a" },
      "2026-07-10T12:01:00.000Z"
    );
    await expect(
      repository.update({
        changeSet: updated,
        expectedVersion: versionOf(draft),
        blobs: []
      })
    ).resolves.toEqual(updated);
    await expect(
      repository.delete({
        draftId: DRAFT_ID,
        expectedVersion: versionOf(updated)
      })
    ).resolves.toBeUndefined();

    const verifier = createRepository(root, "studio-release-verifier");
    await expect(verifier.get(DRAFT_ID)).resolves.toBeUndefined();
    expect(notifications).toHaveLength(4);
    expect(notifications.map((item) => item.operationSucceeded)).toEqual([
      true,
      false,
      true,
      true
    ]);
    expect(notifications.every((item) => item.error === releaseError)).toBe(true);
  });

  it("rejects duplicate, unreferenced, and digest-mismatched batch entries", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-batch-validation");
    const baseBlob = blob("base");
    const changeBlob = blob("change");
    const draft = draftWithBlobs({
      baseDigest: baseBlob.digest,
      changeDigest: changeBlob.digest
    });

    await expect(
      repository.create({
        changeSet: draft,
        blobs: [baseBlob, baseBlob, changeBlob]
      })
    ).rejects.toMatchObject({ code: "studio_blob_duplicate" });
    await expect(
      repository.create({
        changeSet: draft,
        blobs: [baseBlob, changeBlob, blob("unused")]
      })
    ).rejects.toMatchObject({ code: "studio_blob_unreferenced" });
    await expect(
      repository.create({
        changeSet: draft,
        blobs: [baseBlob, { digest: changeBlob.digest, content: "wrong" }]
      })
    ).rejects.toMatchObject({ code: "studio_blob_digest_mismatch" });
  });

  it("accepts only lossless UTF-8 blob content", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-utf8");
    const baseBlob = blob("base");
    const invalidContent = "\ud800";
    const invalidBlob = {
      digest: rawDigest(Buffer.from(invalidContent, "utf8")),
      content: invalidContent
    };
    const draft = draftWithBlobs({
      baseDigest: baseBlob.digest,
      changeDigest: invalidBlob.digest
    });

    await expect(
      repository.create({ changeSet: draft, blobs: [baseBlob, invalidBlob] })
    ).rejects.toMatchObject({ code: "studio_blob_content_invalid" });
  });

  it("enforces per-file and aggregate quotas before persisting", async () => {
    const root = await createRoot();
    const smallFileRepository = createRepository(root, "studio-blob-limit", {
      limits: { maxBlobBytes: 4 }
    });
    const baseBlob = blob("12345");
    const changeBlob = blob("ok");
    const draft = draftWithBlobs({
      baseDigest: baseBlob.digest,
      changeDigest: changeBlob.digest
    });
    await expect(
      smallFileRepository.create({
        changeSet: draft,
        blobs: [baseBlob, changeBlob]
      })
    ).rejects.toMatchObject({
      code: "studio_blob_too_large",
      details: { actualBytes: 5, maxBytes: 4 }
    });

    const quotaRoot = await createRoot();
    const quotaRepository = createRepository(quotaRoot, "studio-total-limit", {
      limits: {
        maxBlobBytes: 1_000,
        maxChangeSetBytes: 2_000,
        maxTotalBytes: 2_000
      }
    });
    const largeBase = blob("a".repeat(700));
    const largeChange = blob("b".repeat(700));
    const largeDraft = draftWithBlobs({
      baseDigest: largeBase.digest,
      changeDigest: largeChange.digest
    });
    await expect(
      quotaRepository.create({
        changeSet: largeDraft,
        blobs: [largeBase, largeChange]
      })
    ).rejects.toMatchObject({ code: "studio_storage_quota_exceeded" });
    await expect(quotaRepository.get(DRAFT_ID)).resolves.toBeUndefined();
  });

  it("rejects unsafe storage limit combinations", async () => {
    const root = await createRoot();
    expect(() =>
      createRepository(root, "studio-invalid-limit", {
        limits: { maxTotalBytes: 100 }
      })
    ).toThrow(/cannot be smaller/);
  });

  it("garbage-collects an unreferenced blob left by an interrupted update", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-orphan-gc");
    const { changeBlob } = await seedDraft(repository);
    const orphan = blob("orphaned update content");
    const orphanPath = digestPath(root, DRAFT_ID, orphan.digest);
    await writeFile(orphanPath, orphan.content, { mode: 0o600 });

    await expect(repository.get(DRAFT_ID)).resolves.toBeDefined();
    await expect(stat(orphanPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      repository.getBlob(DRAFT_ID, changeBlob.digest, { maxBytes: 1_000 })
    ).resolves.toBe(changeBlob.content);
  });

  it("installs new content through the update batch and retires old blobs", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-update-batch");
    const { draft, changeBlob } = await seedDraft(repository);
    const replacement = blob("replacement content");
    const updated = replaceStudioDraftContent(
      draft,
      [
        {
          ...draft.changes[0]!,
          action: "write",
          content_sha256: replacement.digest,
          content_ref: replacement.digest
        }
      ],
      "2026-07-10T12:01:00.000Z"
    );

    await repository.update({
      changeSet: updated,
      expectedVersion: versionOf(draft),
      blobs: [replacement]
    });
    await expect(repository.get(DRAFT_ID)).resolves.toEqual(updated);
    await expect(
      repository.getBlob(DRAFT_ID, replacement.digest, { maxBytes: 1_000 })
    ).resolves.toBe(replacement.content);
    await expect(
      stat(digestPath(root, DRAFT_ID, changeBlob.digest))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when stored metadata or referenced blobs are corrupt", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-corrupt");
    const { draft, changeBlob } = await seedDraft(repository);
    const metadataPath = path.join(draftRoot(root), "change-set.json");

    await writeFile(metadataPath, "{not-json", { mode: 0o600 });
    await expect(repository.get(DRAFT_ID)).rejects.toMatchObject({
      code: "studio_draft_corrupt"
    });
    await writeFile(metadataPath, `${JSON.stringify(draft)}\n`, { mode: 0o600 });
    await writeFile(
      digestPath(root, DRAFT_ID, changeBlob.digest),
      "corrupt",
      { mode: 0o600 }
    );
    await expect(repository.get(DRAFT_ID)).rejects.toMatchObject({
      code: "studio_blob_corrupt"
    });
  });

  it("lists metadata only and reports corruption per draft", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-list-diagnostics");
    const first = await seedDraft(repository, DRAFT_IDS[0]);
    await seedDraft(repository, DRAFT_IDS[1]);
    await rm(digestPath(root, DRAFT_IDS[0], first.changeBlob.digest));
    await writeFile(
      path.join(draftRoot(root, DRAFT_IDS[1]), "change-set.json"),
      "bad-json",
      { mode: 0o600 }
    );

    await expect(repository.list()).resolves.toEqual({
      items: [expect.objectContaining({ draft_id: DRAFT_IDS[0] })],
      diagnostics: [
        {
          draft_id: DRAFT_IDS[1],
          code: "studio_draft_corrupt",
          message: "Draft metadata is corrupt."
        }
      ],
      next_cursor: null
    });
    await expect(repository.get(DRAFT_IDS[0])).rejects.toMatchObject({
      code: "studio_blob_missing"
    });
  });

  it("paginates over bounded storage entries with an opaque cursor", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-list-pages");
    for (const draftId of DRAFT_IDS) {
      await seedDraft(repository, draftId);
    }

    const first = await repository.list({ limit: 2 });
    expect(first.items.map((item) => item.draft_id)).toEqual(DRAFT_IDS.slice(0, 2));
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await repository.list({
      limit: 2,
      cursor: first.next_cursor!
    });
    expect(second.items.map((item) => item.draft_id)).toEqual([DRAFT_IDS[2]]);
    expect(second.next_cursor).toBeNull();
    await expect(repository.list({ cursor: "not canonical!" })).rejects.toMatchObject({
      code: "studio_list_cursor_invalid"
    });
    await expect(repository.list({ limit: 101 })).rejects.toMatchObject({
      code: "studio_list_limit_invalid"
    });
  });

  it("paginates a scoped list without exposing skipped configuration IDs", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-scoped-list-pages");
    const baseBlob = blob("name: base\n");
    const changeBlob = blob("name: changed\n");
    for (const [index, draftId] of DRAFT_IDS.entries()) {
      await repository.create({
        changeSet: draftWithBlobs({
          baseDigest: baseBlob.digest,
          changeDigest: changeBlob.digest,
          draftId,
          resource:
            index === 1
              ? { kind: "config", id: "private-config" }
              : { kind: "workflow", id: `visible-${index}` }
        }),
        blobs: [baseBlob, changeBlob]
      });
    }

    const first = await repository.list({
      limit: 1,
      primaryResourceKinds: ["workflow", "agent"]
    });
    expect(first.items.map((item) => item.draft_id)).toEqual([DRAFT_IDS[0]]);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(Buffer.from(first.next_cursor!, "base64url").toString("utf8")).toBe(
      DRAFT_IDS[0]
    );

    const second = await repository.list({
      limit: 1,
      cursor: first.next_cursor!,
      primaryResourceKinds: ["workflow", "agent"]
    });
    expect(second.items.map((item) => item.draft_id)).toEqual([DRAFT_IDS[2]]);
    expect(second.next_cursor).toBeNull();
    expect(JSON.stringify([first, second])).not.toContain(DRAFT_IDS[1]);
  });

  it("bounds directory enumeration and does not run garbage collection from list", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-list-no-maintenance", {
      limits: { maxEntries: 20 }
    });
    await seedDraft(repository);
    const orphan = blob("list must not remove me");
    const orphanPath = digestPath(root, DRAFT_ID, orphan.digest);
    await writeFile(orphanPath, orphan.content, { mode: 0o600 });

    await expect(repository.list()).resolves.toMatchObject({
      items: [expect.objectContaining({ draft_id: DRAFT_ID })]
    });
    await expect(readFile(orphanPath, "utf8")).resolves.toBe(orphan.content);

    const draftsDirectory = path.join(root, ".luna", "studio", "drafts");
    for (let index = 0; index < 21; index += 1) {
      await mkdir(path.join(draftsDirectory, `.noise-${index}`));
    }
    await expect(repository.list()).rejects.toMatchObject({
      code: "studio_storage_quota_exceeded",
      details: { actualEntries: 21, maxEntries: 20 }
    });
  });
});
