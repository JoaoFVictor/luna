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

  it.each([
    ["https://token@github.com/swinggo-dev/swg-front-nuxt.git"],
    ["https://github.com/swinggo-dev/swg-front-nuxt.git?token=secret"],
    ["https://github.com/swinggo-dev/swg-front-nuxt.git#secret"]
  ])("rejects unsafe GitHub HTTPS remote url %s", (value) => {
    expect(() => normalizeRemoteUrl(value)).toThrow(
      expect.objectContaining({ code: "remote_url_unsafe" })
    );
  });

  it("matches normalized remote urls against expected urls", () => {
    expect(
      remoteUrlMatches("git@github.com:swinggo-dev/swg-front-nuxt.git", [
        "https://github.com/swinggo-dev/swg-front-nuxt"
      ])
    ).toBe(true);
  });

  it.each([
    ["https://token@github.com/swinggo-dev/swg-front-nuxt.git"],
    ["https://github.com/swinggo-dev/swg-front-nuxt.git?token=secret"],
    ["https://github.com/swinggo-dev/swg-front-nuxt.git#secret"]
  ])("does not match unsafe actual remote url %s", (actual) => {
    expect(
      remoteUrlMatches(actual, [
        "https://github.com/swinggo-dev/swg-front-nuxt"
      ])
    ).toBe(false);
  });

  it("does not match a different repository", () => {
    expect(
      remoteUrlMatches("git@github.com:swinggo-dev/swg-front-nuxt.git", [
        "https://github.com/swinggo-dev/other-repo"
      ])
    ).toBe(false);
  });
});
