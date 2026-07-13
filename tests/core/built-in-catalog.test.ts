import { describe, expect, it } from "vitest";
import { createBuiltInStepCatalog } from "../../src/core/built-ins/catalog.js";
import { defineBuiltInStep } from "../../src/core/built-ins/registry.js";

describe("built-in step catalog", () => {
  it("preserves the physical workflow node context at the built-in boundary", async () => {
    const catalog = createBuiltInStepCatalog([
      defineBuiltInStep({
        name: "test.context",
        run: ({ node }) => node
      })
    ]);

    await expect(catalog.runBuiltInStep({
      uses: "test.context",
      state: { invocation: {}, steps: {} },
      node: {
        id: "editorial:iteration-12:image",
        capability_id: "test.context"
      }
    })).resolves.toEqual({
      id: "editorial:iteration-12:image",
      capability_id: "test.context"
    });
  });
});
