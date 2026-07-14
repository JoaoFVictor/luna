import { runStoreError } from "../../application/runs/errors.js";
import { studioRunResumeCatalogChanged } from "../../application/runs/resume-errors.js";

export function assertNativeStudioResumeMaterialCompatible(input: {
  readonly sourceExecutionSnapshotHash: string;
  readonly recordExecutionSnapshotHash: string;
  readonly acceptedResumeExecutionSnapshotHash?: string;
  readonly sourceCatalogFingerprint: string;
  readonly recordCatalogFingerprint?: string;
  readonly currentCatalogFingerprint: string;
}): void {
  if (
    input.sourceExecutionSnapshotHash !== input.recordExecutionSnapshotHash ||
    (input.acceptedResumeExecutionSnapshotHash !== undefined &&
      input.sourceExecutionSnapshotHash !== input.acceptedResumeExecutionSnapshotHash) ||
    (input.recordCatalogFingerprint !== undefined &&
      input.sourceCatalogFingerprint !== input.recordCatalogFingerprint)
  ) {
    throw runStoreError(
      "run_store_corrupt",
      "The durable run metadata does not match its pinned execution material"
    );
  }
  if (input.sourceCatalogFingerprint !== input.currentCatalogFingerprint) {
    throw studioRunResumeCatalogChanged();
  }
}
