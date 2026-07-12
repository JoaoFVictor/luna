import {
  StudioSnapshotError,
  type StudioSnapshotErrorDetails
} from "../../application/validation/snapshot.js";
import type { StudioPath } from "../../contracts/paths.js";

export type StudioSnapshotWork = NonNullable<
  StudioSnapshotErrorDetails["work"]
>;

export class StudioSnapshotWorkBudget {
  private usedBytes = 0;

  constructor(
    private readonly maxBytes: number,
    maxFiles: number,
    actualFiles: number
  ) {
    if (actualFiles > maxFiles) {
      throw new StudioSnapshotError(
        "studio_snapshot_too_many_files",
        "Studio validation snapshot contains too many source files",
        { details: { actualFiles, maxFiles } }
      );
    }
  }

  remainingBytes(file: StudioPath, work: StudioSnapshotWork): number {
    const remaining = this.maxBytes - this.usedBytes;
    if (remaining < 1) {
      this.exceeded(file, 1, work);
    }
    return remaining;
  }

  assertFits(file: StudioPath, bytes: number, work: StudioSnapshotWork): void {
    if (bytes > this.maxBytes - this.usedBytes) {
      this.exceeded(file, bytes, work);
    }
  }

  account(file: StudioPath, bytes: number, work: StudioSnapshotWork): void {
    this.assertFits(file, bytes, work);
    this.usedBytes += bytes;
  }

  private exceeded(file: StudioPath, bytes: number, work: StudioSnapshotWork): never {
    throw new StudioSnapshotError(
      "studio_snapshot_total_too_large",
      "Studio validation work exceeds its aggregate size limit",
      {
        details: {
          file,
          actualBytes: this.usedBytes + bytes,
          maxBytes: this.maxBytes,
          work
        }
      }
    );
  }
}
