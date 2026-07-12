import { describe, expect, it } from "vitest";
import { RepositoryConfigSchema } from "../../src/core/config/schemas.js";

function repository(remote: string, expectedRemoteUrls?: string[]) {
  return {
    id: "repo",
    provider: "github",
    owner: "acme",
    name: "repo",
    path: "/repositories/repo",
    remote,
    ...(expectedRemoteUrls === undefined
      ? {}
      : { expected_remote_urls: expectedRemoteUrls })
  };
}

describe("repository remote credential boundaries", () => {
  it.each([
    "https://user:secret@example.test/acme/repo.git",
    "https://token-user@example.test/acme/repo.git",
    "https://example.test/acme/repo.git?access_token=secret"
  ])("rejects credential-bearing remote %s", (remote) => {
    expect(RepositoryConfigSchema.safeParse(repository(remote)).success).toBe(false);
  });

  it("rejects credentials in expected remote URLs", () => {
    const result = RepositoryConfigSchema.safeParse(repository("origin", [
      "https://user:secret@example.test/acme/repo.git"
    ]));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["expected_remote_urls", 0]);
    }
  });

  it.each([
    "origin",
    "git@example.test:acme/repo.git",
    "ssh://git@example.test/acme/repo.git",
    "https://example.test/acme/repo.git"
  ])("allows credential-free remote %s", (remote) => {
    expect(RepositoryConfigSchema.safeParse(repository(remote)).success).toBe(true);
  });
});
