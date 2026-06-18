import { describe, expect, it } from "vitest";
import { createAgent } from "@flue/runtime";

describe("flue import", () => {
  it("imports createAgent from @flue/runtime", () => {
    expect(typeof createAgent).toBe("function");
  });
});
