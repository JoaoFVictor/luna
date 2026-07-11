import type { StudioPath } from "../../contracts/paths.js";
import { StudioApplyError } from "./errors.js";

const DEFAULT_PLAN_TTL_MS = 2 * 60 * 1_000;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_DIFF_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_DIFF_TOTAL_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 512;
const CONTRACT_MAX_DIFF_FILE_BYTES = 256 * 1024;
const CONTRACT_MAX_DIFF_TOTAL_BYTES = 256 * 1024;

export const STUDIO_APPLY_MAX_COMPILER_VERSION_BYTES = 256;

export type StudioApplyLimits = {
  readonly planTtlMs: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxDiffFileBytes: number;
  readonly maxDiffTotalBytes: number;
  readonly maxFiles: number;
};

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StudioApplyError(
      "studio_apply_config_invalid",
      `${label} must be a positive safe integer`
    );
  }
  return value;
}

export function resolveStudioApplyLimits(
  input: Partial<StudioApplyLimits> = {}
): StudioApplyLimits {
  const limits = {
    planTtlMs: input.planTtlMs ?? DEFAULT_PLAN_TTL_MS,
    maxFileBytes: input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: input.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxDiffFileBytes:
      input.maxDiffFileBytes ?? DEFAULT_MAX_DIFF_FILE_BYTES,
    maxDiffTotalBytes:
      input.maxDiffTotalBytes ?? DEFAULT_MAX_DIFF_TOTAL_BYTES,
    maxFiles: input.maxFiles ?? DEFAULT_MAX_FILES
  };
  positiveSafeInteger(limits.planTtlMs, "Apply plan TTL");
  positiveSafeInteger(limits.maxFileBytes, "Apply file byte limit");
  positiveSafeInteger(limits.maxTotalBytes, "Apply total byte limit");
  positiveSafeInteger(limits.maxDiffFileBytes, "Apply file diff byte limit");
  positiveSafeInteger(limits.maxDiffTotalBytes, "Apply total diff byte limit");
  positiveSafeInteger(limits.maxFiles, "Apply file count limit");
  if (limits.maxDiffFileBytes > CONTRACT_MAX_DIFF_FILE_BYTES) {
    throw new StudioApplyError(
      "studio_apply_config_invalid",
      `Apply file diff byte limit cannot exceed ${CONTRACT_MAX_DIFF_FILE_BYTES}`
    );
  }
  if (limits.maxDiffTotalBytes > CONTRACT_MAX_DIFF_TOTAL_BYTES) {
    throw new StudioApplyError(
      "studio_apply_config_invalid",
      `Apply total diff byte limit cannot exceed ${CONTRACT_MAX_DIFF_TOTAL_BYTES}`
    );
  }
  return limits;
}

export class StudioApplyReadBudget {
  readonly #limits: StudioApplyLimits;
  #consumed = 0;

  constructor(limits: StudioApplyLimits) {
    this.#limits = limits;
  }

  nextLimit(file: StudioPath): number {
    const remaining = this.#limits.maxTotalBytes - this.#consumed;
    if (remaining < 1) {
      throw new StudioApplyError(
        "studio_apply_source_too_large",
        "Studio apply source exceeds the aggregate byte limit",
        {
          details: {
            file,
            actualBytes: this.#consumed,
            maxBytes: this.#limits.maxTotalBytes
          }
        }
      );
    }
    return Math.min(this.#limits.maxFileBytes, remaining);
  }

  account(file: StudioPath, bytes: number): void {
    this.#consumed += bytes;
    if (
      bytes > this.#limits.maxFileBytes ||
      this.#consumed > this.#limits.maxTotalBytes
    ) {
      throw new StudioApplyError(
        "studio_apply_source_too_large",
        "Studio apply source exceeds its configured byte limit",
        {
          details: {
            file,
            actualBytes: Math.max(bytes, this.#consumed),
            maxBytes:
              bytes > this.#limits.maxFileBytes
                ? this.#limits.maxFileBytes
                : this.#limits.maxTotalBytes
          }
        }
      );
    }
  }
}
