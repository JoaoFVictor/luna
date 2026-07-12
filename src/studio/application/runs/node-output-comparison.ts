import type { JsonValue } from "../../../core/json/value.js";
import {
  MAX_RUN_NODE_OUTPUT_COMPARISON_CHANGES,
  RunNodeOutputComparisonResponseSchema,
  type RunNodeOutputComparisonResponse,
  type RunNodeOutputResponse
} from "../../contracts/run-node-output.js";

type AvailableOutput = Extract<
  RunNodeOutputResponse,
  { readonly availability: "available" }
>;
type AvailableSnapshot = Extract<
  AvailableOutput["output"],
  { readonly availability: "available" }
>;
type ComparableOutput = {
  readonly response: AvailableOutput;
  readonly snapshot: AvailableSnapshot;
};
type ComparisonChange = Extract<
  RunNodeOutputComparisonResponse,
  { readonly availability: "comparable" }
>["changes"][number];
type OutputUnavailableReason = Extract<
  RunNodeOutputComparisonResponse,
  { readonly availability: "unavailable" }
>["unavailable_sides"][number]["reason"];

function comparableOutput(
  response: RunNodeOutputResponse
): ComparableOutput | undefined {
  return response.availability === "available" &&
    response.output.availability === "available"
    ? { response, snapshot: response.output }
    : undefined;
}

function unavailableReason(
  response: RunNodeOutputResponse
): OutputUnavailableReason | undefined {
  if (response.availability === "unavailable") return response.reason;
  if (response.output.availability === "unavailable") {
    return response.output.reason;
  }
  return undefined;
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameContainerKind(left: JsonValue, right: JsonValue): boolean {
  return Array.isArray(left)
    ? Array.isArray(right)
    : isJsonObject(left) && isJsonObject(right);
}

function compareJsonValues(
  baseline: JsonValue,
  current: JsonValue
): {
  readonly changes: readonly ComparisonChange[];
  readonly summary: {
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
    readonly total: number;
  };
  readonly truncated: boolean;
} {
  const changes: ComparisonChange[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;

  const record = (change: ComparisonChange): void => {
    if (change.kind === "added") added += 1;
    else if (change.kind === "removed") removed += 1;
    else changed += 1;
    if (changes.length < MAX_RUN_NODE_OUTPUT_COMPARISON_CHANGES) {
      changes.push(change);
    }
  };

  const visit = (
    before: JsonValue,
    after: JsonValue,
    path: readonly string[]
  ): void => {
    if (Object.is(before, after)) return;
    if (!sameContainerKind(before, after)) {
      record({ kind: "changed", path: [...path], before, after });
      return;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      const sharedLength = Math.min(before.length, after.length);
      for (let index = 0; index < sharedLength; index += 1) {
        visit(before[index]!, after[index]!, [...path, String(index)]);
      }
      for (let index = sharedLength; index < before.length; index += 1) {
        record({ kind: "removed", path: [...path, String(index)], before: before[index]! });
      }
      for (let index = sharedLength; index < after.length; index += 1) {
        record({ kind: "added", path: [...path, String(index)], after: after[index]! });
      }
      return;
    }
    if (isJsonObject(before) && isJsonObject(after)) {
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      for (const key of keys) {
        const beforeHasKey = Object.hasOwn(before, key);
        const afterHasKey = Object.hasOwn(after, key);
        if (!beforeHasKey) {
          record({ kind: "added", path: [...path, key], after: after[key]! });
        } else if (!afterHasKey) {
          record({ kind: "removed", path: [...path, key], before: before[key]! });
        } else {
          visit(before[key]!, after[key]!, [...path, key]);
        }
      }
    }
  };

  visit(baseline, current, []);
  const total = added + removed + changed;
  return {
    changes,
    summary: { added, removed, changed, total },
    truncated: total > changes.length
  };
}

function comparisonRef(output: ComparableOutput) {
  return {
    run: output.response.run,
    graph_hash: output.response.graph_hash,
    outcome_hash: output.response.outcome_hash,
    redaction_changed: output.snapshot.redaction.changed
  };
}

export function compareRunNodeOutputs(input: {
  readonly baseline: RunNodeOutputResponse;
  readonly current: RunNodeOutputResponse;
}): RunNodeOutputComparisonResponse {
  const { baseline, current } = input;
  if (baseline.run.workflow_id !== current.run.workflow_id) {
    return RunNodeOutputComparisonResponseSchema.parse({
      schema_version: 1,
      availability: "unavailable",
      node_id: current.node_id,
      baseline_run: baseline.run,
      current_run: current.run,
      reason: "workflow_mismatch",
      unavailable_sides: []
    });
  }

  const baselineOutput = comparableOutput(baseline);
  const currentOutput = comparableOutput(current);
  if (baselineOutput === undefined || currentOutput === undefined) {
    const unavailableSide = (
      side: "baseline" | "current",
      response: RunNodeOutputResponse
    ) => {
      const reason = unavailableReason(response);
      if (reason === undefined) {
        throw new Error("Unavailable comparison side lacks a retention reason");
      }
      return { side, reason };
    };
    return RunNodeOutputComparisonResponseSchema.parse({
      schema_version: 1,
      availability: "unavailable",
      node_id: current.node_id,
      baseline_run: baseline.run,
      current_run: current.run,
      reason: "output_unavailable",
      unavailable_sides: [
        ...(baselineOutput === undefined
          ? [unavailableSide("baseline", baseline)]
          : []),
        ...(currentOutput === undefined
          ? [unavailableSide("current", current)]
          : [])
      ]
    });
  }

  const comparison = compareJsonValues(
    baselineOutput.snapshot.value,
    currentOutput.snapshot.value
  );
  return RunNodeOutputComparisonResponseSchema.parse({
    schema_version: 1,
    availability: "comparable",
    workflow_id: current.run.workflow_id,
    node_id: current.node_id,
    baseline: comparisonRef(baselineOutput),
    current: comparisonRef(currentOutput),
    same_workflow_revision:
      baseline.run.workflow_revision === current.run.workflow_revision,
    ...comparison,
    redaction: "best_effort"
  });
}
