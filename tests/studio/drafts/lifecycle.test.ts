import { describe, expect, it, vi } from "vitest";
import { replaceStudioDraftLayout } from "../../../src/studio/application/drafts/change-set.js";
import {
  StudioDraftLifecycle,
  type StudioDraftLifecycleFailure
} from "../../../src/studio/application/drafts/lifecycle.js";
import { StudioDraftPersistenceError } from "../../../src/studio/application/drafts/persistence.js";
import { studioDraftEtag } from "../../../src/studio/application/drafts/versioning.js";
import {
  AUTHORING_DRAFT_ID,
  MemoryAuthoringDrafts,
  PRESENTATION_FINGERPRINT,
  TECHNICAL_FINGERPRINT
} from "./authoring-test-support.js";

const NOW = new Date("2026-07-11T02:00:00.000Z");

class TestLifecycleError extends Error {
  readonly failure: StudioDraftLifecycleFailure;

  constructor(failure: StudioDraftLifecycleFailure) {
    super(failure.kind, {
      cause:
        failure.kind === "clock_invalid" ||
        failure.kind === "revision_conflict"
          ? failure.cause
          : undefined
    });
    this.failure = failure;
  }
}

function createInput() {
  const resource = { kind: "workflow" as const, id: "lifecycle" };
  return {
    primaryResource: resource,
    resources: [resource],
    resourceRevisions: { "workflow:lifecycle": null },
    baseBundleHash: null,
    baseFiles: [],
    dependencies: [],
    allowedFiles: [],
    changes: [],
    blobs: []
  };
}

function fixture(options: {
  readonly now?: () => Date;
  readonly technical?: string;
} = {}) {
  const drafts = new MemoryAuthoringDrafts();
  const lifecycle = new StudioDraftLifecycle({
    drafts,
    catalogs: {
      technical: () => options.technical ?? TECHNICAL_FINGERPRINT,
      presentation: () => PRESENTATION_FINGERPRINT
    },
    errors: (failure) => new TestLifecycleError(failure),
    now: options.now ?? (() => NOW),
    randomDraftId: () => AUTHORING_DRAFT_ID
  });
  return { drafts, lifecycle };
}

describe("StudioDraftLifecycle", () => {
  it("owns strictly monotonic create/update timestamps against persisted state", async () => {
    const earlier = new Date(NOW.getTime() - 1_000);
    const clock = vi
      .fn<() => Date>()
      .mockReturnValueOnce(NOW)
      .mockReturnValue(earlier);
    const { lifecycle } = fixture({ now: clock });
    const created = await lifecycle.create(createInput());
    const updated = await lifecycle.updateCas({
      current: created,
      mutate: (timestamp) => ({
        changeSet: replaceStudioDraftLayout(
          created,
          { selected: "node" },
          timestamp
        ),
        blobs: []
      })
    });

    expect(Date.parse(updated.updated_at)).toBe(
      Date.parse(created.updated_at) + 1
    );
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("owns fingerprint and clock validation through the domain error projection", async () => {
    await expect(
      fixture({ technical: "invalid" }).lifecycle.create(createInput())
    ).rejects.toMatchObject({
      failure: {
        kind: "catalog_fingerprint_invalid",
        catalog: "technical"
      }
    });
    await expect(
      fixture({ now: () => new Date(Number.NaN) }).lifecycle.create(
        createInput()
      )
    ).rejects.toMatchObject({ failure: { kind: "clock_invalid" } });
  });

  it("translates update and validation races from the same CAS authority", async () => {
    const updateFixture = fixture();
    const updateDraft = await updateFixture.lifecycle.create(createInput());
    vi.spyOn(updateFixture.drafts, "update").mockRejectedValueOnce(
      new StudioDraftPersistenceError(
        "studio_draft_revision_conflict",
        "simulated update race"
      )
    );
    await expect(
      updateFixture.lifecycle.updateCas({
        current: updateDraft,
        mutate: (timestamp) => ({
          changeSet: replaceStudioDraftLayout(
            updateDraft,
            { selected: "raced" },
            timestamp
          ),
          blobs: []
        })
      })
    ).rejects.toMatchObject({
      failure: { kind: "revision_conflict", phase: "update" }
    });

    const validationUpdateFixture = fixture();
    const pending = await validationUpdateFixture.lifecycle.create(
      createInput()
    );
    vi.spyOn(validationUpdateFixture.drafts, "update").mockRejectedValueOnce(
      new StudioDraftPersistenceError(
        "studio_draft_revision_conflict",
        "simulated validation race"
      )
    );
    await expect(
      validationUpdateFixture.lifecycle.persistValidation(pending, "valid")
    ).rejects.toMatchObject({
      failure: {
        kind: "revision_conflict",
        phase: "validation_update"
      }
    });

    const validationReadbackFixture = fixture();
    const created = await validationReadbackFixture.lifecycle.create(
      createInput()
    );
    const validated = await validationReadbackFixture.lifecycle.persistValidation(
      created,
      "valid"
    );
    validationReadbackFixture.drafts.draft = replaceStudioDraftLayout(
      validated,
      { selected: "concurrent" },
      new Date(Date.parse(validated.updated_at) + 1).toISOString()
    );
    await expect(
      validationReadbackFixture.lifecycle.persistValidation(validated, "valid")
    ).rejects.toMatchObject({
      failure: {
        kind: "revision_conflict",
        phase: "validation_readback",
        actualEtag: studioDraftEtag(validationReadbackFixture.drafts.draft)
      }
    });
  });
});
