import { describe, expect, it } from "vitest";
import { resolveRepository } from "../../src/core/workflow/workspace-resolver.js";
import type { Invocation } from "../../src/core/invocation/types.js";
import { gitRepository } from "../fixtures/git-repo.js";

const githubInvocation = {
  version: "2026-06",
  source: "github",
  event: "pull_request",
  action: "selected",
  target: { type: "workflow", id: "code-review" },
  repository: {
    provider: "github",
    owner: "Octo-Org",
    name: "Hello-World"
  },
  subject: { type: "pull_request", id: "42" }
} as const satisfies Invocation;

const jiraInvocation = {
  version: "2026-06",
  source: "jira",
  event: "issue",
  action: "selected",
  target: { type: "workflow", id: "implementation" },
  repository: {
    provider: "github",
    owner: "swinggo-dev",
    name: "swg-front-nuxt"
  },
  subject: { type: "issue", id: "ABC-123" }
} as const satisfies Invocation;

describe("workspace resolver", () => {
  it("matches github repositories by invocation repository owner and name", () => {
    const repository = resolveRepository(githubInvocation, [
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

  it("matches repository provider case-insensitively", () => {
    const repository = resolveRepository(
      {
        ...githubInvocation,
        repository: {
          ...githubInvocation.repository,
          provider: "GitHub"
        }
      },
      [gitRepository]
    );

    expect(repository).toBe(gitRepository);
  });

  it("matches jira repositories by invocation repository owner and name", () => {
    const jiraRepository = {
      ...gitRepository,
      id: "swg-front-nuxt",
      owner: "swinggo-dev",
      name: "swg-front-nuxt"
    };

    const repository = resolveRepository(jiraInvocation, [
      gitRepository,
      jiraRepository
    ]);

    expect(repository).toBe(jiraRepository);
  });

  it("throws repository_not_configured when no repository matches", () => {
    expect(() =>
      resolveRepository(githubInvocation, [
        {
          ...gitRepository,
          owner: "someone-else"
        }
      ])
    ).toThrow(expect.objectContaining({ code: "repository_not_configured" }));
  });

  it("throws repository_not_configured when no jira repository matches", () => {
    expect(() => resolveRepository(jiraInvocation, [gitRepository])).toThrow(
      expect.objectContaining({ code: "repository_not_configured" })
    );
  });

  it("throws repository_not_configured when invocation has no repository", () => {
    const invocationWithoutRepository = {
      version: "2026-06",
      source: "github",
      event: "pull_request",
      action: "selected",
      target: { type: "workflow", id: "code-review" },
      subject: { type: "pull_request", id: "42" }
    } as const satisfies Invocation;

    expect(() =>
      resolveRepository(invocationWithoutRepository, [gitRepository])
    ).toThrow(expect.objectContaining({ code: "repository_not_configured" }));
  });
});
