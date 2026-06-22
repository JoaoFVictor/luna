import { describe, expect, it } from "vitest";
import {
  normalizeRemoteUrl,
  remoteUrlMatches
} from "../../src/core/git/remote-url.js";

describe("remote url", () => {
  it.each([
    ["git@github.com:octo-org/hello-world.git"],
    ["https://github.com/octo-org/hello-world.git"],
    ["https://github.com/octo-org/hello-world"]
  ])("normalizes %s", (value) => {
    expect(normalizeRemoteUrl(value)).toBe(
      "github.com/octo-org/hello-world"
    );
  });

  it.each([
    ["https://token@github.com/octo-org/hello-world.git"],
    ["https://github.com/octo-org/hello-world.git?token=secret"],
    ["https://github.com/octo-org/hello-world.git#secret"]
  ])("rejects unsafe GitHub HTTPS remote url %s", (value) => {
    expect(() => normalizeRemoteUrl(value)).toThrow(
      expect.objectContaining({ code: "remote_url_unsafe" })
    );
  });

  it("matches normalized remote urls against expected urls", () => {
    expect(
      remoteUrlMatches("git@github.com:octo-org/hello-world.git", [
        "https://github.com/octo-org/hello-world"
      ])
    ).toBe(true);
  });

  it.each([
    ["https://token@github.com/octo-org/hello-world.git"],
    ["https://github.com/octo-org/hello-world.git?token=secret"],
    ["https://github.com/octo-org/hello-world.git#secret"]
  ])("does not match unsafe actual remote url %s", (actual) => {
    expect(
      remoteUrlMatches(actual, [
        "https://github.com/octo-org/hello-world"
      ])
    ).toBe(false);
  });

  it("does not match a different repository", () => {
    expect(
      remoteUrlMatches("git@github.com:octo-org/hello-world.git", [
        "https://github.com/octo-org/other-repo"
      ])
    ).toBe(false);
  });
});
