import { describe, expect, it } from "vitest";
import { STUDIO_CONFIGURATION_LIMITS } from "../../../src/studio/contracts/configuration.js";
import { studioConfigurationReferences } from "../../../src/studio/application/configuration/source.js";

describe("Studio workflow configuration source", () => {
  it("bounds and sorts projected $.config references", () => {
    const source = Array.from(
      { length: STUDIO_CONFIGURATION_LIMITS.maxReferences + 40 },
      (_, index) => `$.config.value_${String(index).padStart(3, "0")}`
    )
      .reverse()
      .join("\n");

    const references = studioConfigurationReferences(source);

    expect(references).toHaveLength(STUDIO_CONFIGURATION_LIMITS.maxReferences);
    expect(references).toEqual([...references].sort());
    expect(references.at(-1)).toBe("$.config.value_255");
  });
});
