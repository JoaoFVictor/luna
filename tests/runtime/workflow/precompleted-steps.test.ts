import { describe, expect, it } from "vitest";
import {
  mergePrecompletedStepsWithRecovery,
  selectEffectivePrecompletedSteps
} from "../../../src/runtime/workflow/precompleted-steps.js";

describe("precompleted step recovery", () => {
  it("unions identical recovered outputs with precompleted outputs", () => {
    expect(mergePrecompletedStepsWithRecovery(
      { supplied: { value: 1 } },
      { supplied: { value: 1 }, durable: { value: 2 } }
    )).toEqual({ supplied: { value: 1 }, durable: { value: 2 } });
  });

  it("rejects a conflicting durable output for a precompleted node", () => {
    expect(() => mergePrecompletedStepsWithRecovery(
      { supplied: { value: 1 } },
      { supplied: { value: 2 } }
    )).toThrow(expect.objectContaining({
      code: "runtime_checkpoint_schema_mismatch"
    }));
  });

  it("keeps only selected cutpoints that survived effective-DAG projection", () => {
    const compiled = {
      workflow_id: "workflow",
      nodes: [{ id: "downstream" }]
    } as Parameters<typeof selectEffectivePrecompletedSteps>[0];

    expect(selectEffectivePrecompletedSteps(compiled, {
      upstream: { ignored: true },
      downstream: { supplied: true }
    })).toEqual({ downstream: { supplied: true } });
    expect(selectEffectivePrecompletedSteps(compiled, undefined)).toBeUndefined();
  });
});
