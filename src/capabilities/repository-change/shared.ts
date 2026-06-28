import type { AcceptanceDecision } from "../../core/decisions/types.js";
import type { WorktreeDiff } from "../git/diff/worktree-diff.js";

export function lifecycleContractError(message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = "built_in_lifecycle_contract_invalid";

  return error;
}

export function skipped(
  enabled: boolean,
  reason: string
): { enabled: boolean; skipped: true; reason: string } {
  return { enabled, skipped: true, reason };
}

export function isAccepted(acceptance: AcceptanceDecision): boolean {
  return acceptance.status === "accepted";
}

export function hasDiff(diff: WorktreeDiff): boolean {
  return (
    diff.files.length > 0 ||
    diff.untracked_files.length > 0 ||
    diff.staged_diff.trim() !== "" ||
    diff.unstaged_diff.trim() !== ""
  );
}

export function stageablePaths(diff: WorktreeDiff): string[] {
  const paths: string[] = [];

  for (const file of diff.files) {
    if (file.status === "untracked") {
      if (file.untracked_summary?.omitted_reason === "sensitive_path") {
        continue;
      }

      paths.push(file.path);
      continue;
    }

    paths.push(file.path);
  }

  return [...new Set(paths)];
}
