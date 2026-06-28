import { describe, expect, it } from "vitest";
import {
  normalizeRemoteUrl,
  remoteUrlMatches
} from "../../src/capabilities/git/remote-url.js";

describe("remote url", () => {
  it("normalizes GitHub SSH remotes", () => {
    expect(normalizeRemoteUrl("git@github.com:octo-org/hello-world.git")).toBe(
      "github.com/octo-org/hello-world"
    );
  });

  it("rejects unsafe GitHub HTTPS remote urls", () => {
    expect(() =>
      normalizeRemoteUrl("https://token@github.com/octo-org/hello-world.git")
    ).toThrow(
      expect.objectContaining({ code: "remote_url_unsafe" })
    );
  });

  it("does not match unsafe actual remote urls", () => {
    expect(
      remoteUrlMatches("https://token@github.com/octo-org/hello-world.git", [
        "https://github.com/octo-org/hello-world"
      ])
    ).toBe(false);
  });
});
