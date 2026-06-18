import { describe, expect, it } from "vitest";
import { resolveRepository } from "../../src/core/workspace-resolver.js";
import { gitInvocation, gitRepository } from "../fixtures/git-repo.js";

describe("workspace resolver", () => {
  it("matches repositories by provider, owner, and name", () => {
    const repository = resolveRepository(gitInvocation, [
      {
        ...gitRepository,
        id: "other",
        owner: "octo-org",
        name: "other-repo"
      },
      gitRepository
    ]);

    expect(repository).toBe(gitRepository);
  });

  it("throws repository_not_configured when no repository matches", () => {
    expect(() =>
      resolveRepository(gitInvocation, [
        {
          ...gitRepository,
          owner: "someone-else"
        }
      ])
    ).toThrow(expect.objectContaining({ code: "repository_not_configured" }));
  });
});
