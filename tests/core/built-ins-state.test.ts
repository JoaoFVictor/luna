import { describe, expect, it } from "vitest";
import { resolvedInput } from "../../src/core/built-ins/state.js";

describe("built-in state helpers", () => {
  it("does not resolve legacy $.path strings inside built-in input", () => {
    expect(
      resolvedInput(
        {
          value: "$.steps.previous.value",
          nested: ["$.invocation.title"]
        },
        {
          invocation: { title: "Resolved elsewhere" },
          steps: { previous: { value: "Resolved elsewhere" } }
        }
      )
    ).toEqual({
      value: "$.steps.previous.value",
      nested: ["$.invocation.title"]
    });
  });
});
