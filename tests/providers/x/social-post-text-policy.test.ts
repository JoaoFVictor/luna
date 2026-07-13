import { describe, expect, it } from "vitest";
import {
  validateXText,
  xWeightedTextLength,
  X_TRANSFORMED_URL_LENGTH
} from "../../../src/providers/x/social-post/text-policy.js";

describe("X weighted text policy", () => {
  it("uses the t.co transformed length for long URLs", () => {
    const url = `https://example.com/${"a".repeat(500)}`;
    expect(xWeightedTextLength(url)).toBe(X_TRANSFORMED_URL_LENGTH);
    expect(validateXText(url).valid).toBe(true);
  });

  it("weights Unicode and emoji according to the declared provider policy", () => {
    expect(xWeightedTextLength("Olá 🚀 漢字")).toBe(11);
    expect(xWeightedTextLength("👨‍👩‍👧‍👦")).toBe(2);
    expect(xWeightedTextLength("e\u0301")).toBe(1);
  });

  it("rejects content over 280 weighted units even below the raw hard bound", () => {
    expect(validateXText("漢".repeat(140))).toMatchObject({
      valid: true,
      weighted_length: 280
    });
    expect(validateXText("漢".repeat(141))).toMatchObject({
      valid: false,
      weighted_length: 282
    });
  });
});
