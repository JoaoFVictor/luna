import { describe, expect, it } from "vitest";
import { StudioRunResumeError } from "../../../src/studio/application/runs/resume-errors.js";
import { RunStoreError } from "../../../src/studio/application/runs/errors.js";
import { assertNativeStudioResumeMaterialCompatible } from "../../../src/studio/adapters/native/run-resume-compatibility.js";

const compatible = {
  sourceExecutionSnapshotHash: "sha256:execution",
  recordExecutionSnapshotHash: "sha256:execution",
  acceptedResumeExecutionSnapshotHash: "sha256:execution",
  sourceCatalogFingerprint: "sha256:catalog",
  recordCatalogFingerprint: "sha256:catalog",
  currentCatalogFingerprint: "sha256:catalog"
};

describe("native Studio resume compatibility", () => {
  it("accepts matching pinned execution material", () => {
    expect(() => assertNativeStudioResumeMaterialCompatible(compatible)).not.toThrow();
  });

  it.each([
    { recordExecutionSnapshotHash: "sha256:other" },
    { acceptedResumeExecutionSnapshotHash: "sha256:other" },
    { recordCatalogFingerprint: "sha256:other" }
  ])("classifies inconsistent durable metadata as storage corruption", (override) => {
    expect(() => assertNativeStudioResumeMaterialCompatible({
      ...compatible,
      ...override
    })).toThrowError(expect.objectContaining<Partial<RunStoreError>>({
      code: "run_store_corrupt"
    }));
  });

  it("classifies a changed current capability catalog as safe resume incompatibility", () => {
    expect(() => assertNativeStudioResumeMaterialCompatible({
      ...compatible,
      currentCatalogFingerprint: "sha256:deployed-catalog"
    })).toThrowError(expect.objectContaining<Partial<StudioRunResumeError>>({
      code: "studio_run_resume_catalog_changed"
    }));
  });
});
