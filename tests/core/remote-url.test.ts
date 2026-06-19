import { describe, expect, it } from "vitest";
import {
  normalizeRemoteUrl,
  remoteUrlMatches
} from "../../src/core/remote-url.js";

describe("remote url", () => {
  it.each([
    ["git@github.com:swinggo-dev/swg-front-nuxt.git"],
    ["https://github.com/swinggo-dev/swg-front-nuxt.git"],
    ["https://github.com/swinggo-dev/swg-front-nuxt"]
  ])("normalizes %s", (value) => {
    expect(normalizeRemoteUrl(value)).toBe(
      "github.com/swinggo-dev/swg-front-nuxt"
    );
  });

  it("matches normalized remote urls against expected urls", () => {
    expect(
      remoteUrlMatches("git@github.com:swinggo-dev/swg-front-nuxt.git", [
        "https://github.com/swinggo-dev/swg-front-nuxt"
      ])
    ).toBe(true);
  });

  it("does not match a different repository", () => {
    expect(
      remoteUrlMatches("git@github.com:swinggo-dev/swg-front-nuxt.git", [
        "https://github.com/swinggo-dev/other-repo"
      ])
    ).toBe(false);
  });
});
