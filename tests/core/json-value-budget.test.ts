import { describe, expect, it } from "vitest";
import { jsonValueBudgetViolation } from "../../src/core/json/value.js";

const budget = {
  maxBytes: 128,
  maxDepth: 2,
  maxEntries: 4,
  maxKeyLength: 8
};

describe("JSON value budgets", () => {
  it("accepts bounded plain JSON", () => {
    expect(jsonValueBudgetViolation({ ok: [1, true] }, budget)).toBeUndefined();
  });

  it("bounds depth, entries, keys, bytes, and finite numbers", () => {
    expect(jsonValueBudgetViolation({ a: { b: { c: 1 } } }, budget)).toBe(
      "depth"
    );
    expect(jsonValueBudgetViolation([1, 2, 3, 4, 5], budget)).toBe("entries");
    expect(jsonValueBudgetViolation({ oversized_key: true }, budget)).toBe(
      "key_length"
    );
    expect(jsonValueBudgetViolation("x".repeat(128), budget)).toBe("bytes");
    expect(jsonValueBudgetViolation(Number.NaN, budget)).toBe(
      "non_finite_number"
    );
  });

  it("rejects aliases and cycles before serialization", () => {
    const shared = { value: true };
    const aliased = { left: shared, right: shared };
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(jsonValueBudgetViolation(aliased, budget)).toBe("alias_or_cycle");
    expect(jsonValueBudgetViolation(cyclic, budget)).toBe("alias_or_cycle");
  });
});
