import { describe, expect, it } from "vitest";
import { resolveRepository } from "../../src/core/workspace-resolver.js";
import type { JiraTaskInvocation } from "../../src/core/types.js";
import { gitInvocation, gitRepository } from "../fixtures/git-repo.js";

describe("workspace resolver", () => {
  it("matches github_pr repositories by top-level provider, owner, and name", () => {
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

  it("matches jira_task repositories by invocation repository owner and name", () => {
    const jiraInvocation: JiraTaskInvocation = {
      target: "jira_task",
      workflow: "implementation",
      jira: {
        instance_id: "company",
        issue_key: "ABC-123",
        url: "https://company.atlassian.net/browse/ABC-123",
        summary: "Fix checkout validation",
        description: "Reject invalid checkout payloads.",
        acceptance_criteria: "Invalid payloads fail validation.",
        status: "To Do",
        issue_type: "Task"
      },
      repository: {
        provider: "github",
        owner: "swinggo-dev",
        name: "swg-front-nuxt"
      }
    };
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
      resolveRepository(gitInvocation, [
        {
          ...gitRepository,
          owner: "someone-else"
        }
      ])
    ).toThrow(expect.objectContaining({ code: "repository_not_configured" }));
  });

  it("throws repository_not_configured when no jira_task repository matches", () => {
    const jiraInvocation: JiraTaskInvocation = {
      target: "jira_task",
      workflow: "implementation",
      jira: {
        instance_id: "company",
        issue_key: "ABC-123",
        url: "https://company.atlassian.net/browse/ABC-123",
        summary: "Fix checkout validation",
        description: "Reject invalid checkout payloads.",
        acceptance_criteria: "Invalid payloads fail validation.",
        status: "To Do",
        issue_type: "Task"
      },
      repository: {
        provider: "github",
        owner: "swinggo-dev",
        name: "swg-front-nuxt"
      }
    };

    expect(() => resolveRepository(jiraInvocation, [gitRepository])).toThrow(
      expect.objectContaining({ code: "repository_not_configured" })
    );
  });
});
