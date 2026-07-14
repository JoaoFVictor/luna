import { describe, expect, it } from "vitest";
import { wordsFrom } from "../../../src/capabilities/repository-context/symbol-analysis/terms.js";

describe("repository context terms", () => {
  it("keeps Unicode task words intact and rejects numeric-only tokens", () => {
    expect(wordsFrom("Publicação e comentário 123 FeatureSlug")).toEqual([
      "Publicação",
      "comentário",
      "FeatureSlug"
    ]);
  });
});
