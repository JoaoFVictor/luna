import type { ParsedWorkflowGate } from "../../core/workflow/definition-types.js";
import type { ValidationResult } from "../../core/validation/runner.js";

export const VALIDATION_GATE = "quality-gates.validation_commands";
export const NON_EMPTY_DIFF_GATE = "quality-gates.non_empty_diff";

export type DeterministicGateResult = {
  readonly id: string;
  readonly type: string;
  readonly passed: boolean;
  readonly feedback?: string;
  readonly output: unknown;
};

export function deterministicGateResult({
  gate,
  validation,
  diffSummary
}: {
  readonly gate: ParsedWorkflowGate;
  readonly validation: ValidationResult;
  readonly diffSummary: unknown;
}): DeterministicGateResult | undefined {
  if (gate.type === VALIDATION_GATE) {
    return validationGateResult(gate.id, gate.type, validation);
  }

  if (gate.type === NON_EMPTY_DIFF_GATE) {
    return nonEmptyDiffGateResult(gate.id, diffSummary);
  }

  return undefined;
}

function validationGateResult(
  id: string,
  type: string,
  validation: ValidationResult
): DeterministicGateResult {
  return {
    id,
    type,
    passed: validation.passed,
    ...(validation.passed
      ? {}
      : { feedback: JSON.stringify(validation.commands ?? []) }),
    output: validation
  };
}

function nonEmptyDiffGateResult(
  id: string,
  diffSummary: unknown
): DeterministicGateResult {
  const changed = diffSummaryHasChanges(diffSummary);
  if (changed) {
    return {
      id,
      type: NON_EMPTY_DIFF_GATE,
      passed: true,
      output: diffSummary
    };
  }

  return {
    id,
    type: NON_EMPTY_DIFF_GATE,
    passed: false,
    feedback: "No repository changes were detected. Inspect the worktree, edit files with repository_write_file or repository_delete_file, then return only after git diff/status shows actual changes.",
    output: diffSummary
  };
}

function diffSummaryHasChanges(diffSummary: unknown): boolean {
  if (typeof diffSummary !== "object" || diffSummary === null || Array.isArray(diffSummary)) {
    return false;
  }

  const record = diffSummary as Record<string, unknown>;
  return (
    nonEmptyArray(record.files) ||
    nonEmptyArray(record.untracked_files) ||
    nonEmptyString(record.staged_diff) ||
    nonEmptyString(record.unstaged_diff)
  );
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
