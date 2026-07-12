import { studioApplyValueDigest } from "./digests.js";
import { StudioApplyError } from "./errors.js";

export function assertSameStudioApplyValue(
  actual: unknown,
  expected: unknown,
  code: "studio_apply_plan_stale" | "studio_apply_validation_failed",
  message: string
): void {
  if (studioApplyValueDigest(actual) !== studioApplyValueDigest(expected)) {
    throw new StudioApplyError(code, message);
  }
}
