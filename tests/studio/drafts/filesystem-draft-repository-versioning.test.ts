import { describe, expect, it } from "vitest";
import {
  computeStudioDraftHash,
  replaceStudioDraftContent,
  replaceStudioDraftLayout,
  replaceStudioDraftStatus
} from "../../../src/studio/application/drafts/change-set.js";
import {
  blob,
  createRepository,
  createRoot,
  DRAFT_ID,
  rawDigest,
  seedDraft,
  versionOf
} from "./filesystem-draft-repository-test-support.js";

describe("filesystem Studio draft repository versioning", () => {
  it("serializes optimistic updates across repository instances", async () => {
    const root = await createRoot();
    const firstRepository = createRepository(root, "studio-concurrent-1");
    const secondRepository = createRepository(root, "studio-concurrent-2");
    const { draft } = await seedDraft(firstRepository);
    const firstUpdate = replaceStudioDraftLayout(
      draft,
      { selected: "first" },
      "2026-07-10T12:01:00.000Z"
    );
    const secondUpdate = replaceStudioDraftLayout(
      draft,
      { selected: "second" },
      "2026-07-10T12:01:00.000Z"
    );

    const results = await Promise.allSettled([
      firstRepository.update({
        changeSet: firstUpdate,
        expectedVersion: versionOf(draft),
        blobs: []
      }),
      secondRepository.update({
        changeSet: secondUpdate,
        expectedVersion: versionOf(draft),
        blobs: []
      })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          code: "studio_draft_revision_conflict"
        })
      })
    ]);
  });

  it("validates revision movement in both semantic directions", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-versioning");
    const { draft, baseBlob, changeBlob } = await seedDraft(repository);
    const advancedWithoutLayoutChange = {
      ...draft,
      record_revision: 2,
      layout_revision: 1,
      updated_at: "2026-07-10T12:01:00.000Z"
    };
    await expect(
      repository.update({
        changeSet: advancedWithoutLayoutChange,
        expectedVersion: versionOf(draft),
        blobs: []
      })
    ).rejects.toThrow(/advanced without a layout change/);

    const contentRevisionWithoutContent = {
      ...draft,
      record_revision: 2,
      content_revision: 2,
      updated_at: "2026-07-10T12:01:00.000Z"
    };
    await expect(
      repository.update({
        changeSet: contentRevisionWithoutContent,
        expectedVersion: versionOf(draft),
        blobs: []
      })
    ).rejects.toThrow(/advanced without a content change/);

    const changedLayoutWithoutRevision = {
      ...draft,
      record_revision: 2,
      layout: { selected: "node-a" },
      updated_at: "2026-07-10T12:01:00.000Z"
    };
    await expect(
      repository.update({
        changeSet: changedLayoutWithoutRevision,
        expectedVersion: versionOf(draft),
        blobs: []
      })
    ).rejects.toThrow(/changed without advancing layout revision/);

    const newContent = blob("replacement");
    const contentUpdate = replaceStudioDraftContent(
      draft,
      [
        {
          ...draft.changes[0]!,
          action: "write",
          content_sha256: newContent.digest,
          content_ref: newContent.digest
        }
      ],
      "2026-07-10T12:01:00.000Z"
    );
    const changedContentWithoutRevision = {
      ...contentUpdate,
      content_revision: draft.content_revision
    };
    await expect(
      repository.update({
        changeSet: changedContentWithoutRevision,
        expectedVersion: versionOf(draft),
        blobs: [newContent]
      })
    ).rejects.toThrow(/changed without advancing content revision/);

    const timestampOnly = {
      ...draft,
      record_revision: 2,
      updated_at: "2026-07-10T12:01:00.000Z"
    };
    await expect(
      repository.update({
        changeSet: timestampOnly,
        expectedVersion: versionOf(draft),
        blobs: []
      })
    ).rejects.toThrow(/must change persisted semantics/);

    const expandedResources = {
      ...draft,
      resources: [
        ...draft.resources,
        { kind: "agent", id: "helper" } as const
      ],
      resource_revisions: {
        ...draft.resource_revisions,
        "agent:helper": rawDigest("helper-revision")
      }
    };
    const expanded = {
      ...expandedResources,
      draft_hash: computeStudioDraftHash(expandedResources)
    };
    const reorderRoot = await createRoot();
    const reorderRepository = createRepository(
      reorderRoot,
      "studio-reorder-noop"
    );
    await reorderRepository.create({
      changeSet: expanded,
      blobs: [baseBlob, changeBlob]
    });
    const reordered = {
      ...expanded,
      resources: [...expanded.resources].reverse(),
      record_revision: 2,
      updated_at: "2026-07-10T12:01:00.000Z"
    };
    await expect(
      reorderRepository.update({
        changeSet: reordered,
        expectedVersion: versionOf(expanded),
        blobs: []
      })
    ).rejects.toThrow(/must change persisted semantics/);

    const explicitNullLayout = {
      ...draft,
      layout: null,
      record_revision: 2,
      updated_at: "2026-07-10T12:01:00.000Z"
    };
    await expect(
      repository.update({
        changeSet: explicitNullLayout,
        expectedVersion: versionOf(draft),
        blobs: []
      })
    ).rejects.toThrow(/must change persisted semantics/);
  });

  it("persists status through record revision only", async () => {
    const root = await createRoot();
    const repository = createRepository(root, "studio-status");
    const { draft } = await seedDraft(repository);
    const validated = replaceStudioDraftStatus(
      draft,
      "valid",
      "2026-07-10T12:02:00.000Z"
    );
    await repository.update({
      changeSet: validated,
      expectedVersion: versionOf(draft),
      blobs: []
    });
    await expect(repository.get(DRAFT_ID)).resolves.toMatchObject({
      status: "valid",
      record_revision: 2,
      content_revision: 1,
      layout_revision: 0
    });
  });
});
