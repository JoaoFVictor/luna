import { describe, expect, it, vi } from "vitest";
import { fetchJiraTaskInvocation } from "../../src/core/jira-adapter.js";
import type {
  JiraConfig,
  LunaAuthConfig,
  RepositoryConfig
} from "../../src/core/types.js";

const jiraConfig: JiraConfig = {
  instances: [
    {
      id: "company",
      base_url: "https://company.atlassian.net",
      repository_field: {
        field_id: "customfield_12345",
        format: "github_full_name"
      },
      acceptance_criteria_field: {
        field_id: "customfield_67890",
        format: "markdown"
      }
    }
  ]
};

const lunaAuth: LunaAuthConfig = {
  providers: {
    jira: {
      company: {
        base_url: "https://company.atlassian.net",
        auth_type: "basic_api_token",
        email: "user@company.com",
        api_token: "secret-token"
      }
    }
  }
};

const repositories: RepositoryConfig[] = [
  {
    id: "swg-front-nuxt",
    provider: "github",
    owner: "swinggo-dev",
    name: "swg-front-nuxt",
    path: "/tmp/swg-front-nuxt",
    remote: "origin"
  }
];

const jiraIssue = {
  key: "ABC-123",
  fields: {
    summary: "Fix checkout validation",
    description: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Checkout should reject orders " },
            { type: "text", text: "without a customer document." }
          ]
        }
      ]
    },
    customfield_67890: "Validation rejects missing documents.",
    customfield_12345: "swinggo-dev/swg-front-nuxt",
    status: {
      name: "To Do"
    },
    issuetype: {
      name: "Task"
    }
  }
};

function adapterOptions(overrides: {
  issue?: unknown;
  configuredRepositories?: RepositoryConfig[];
  configuredJira?: JiraConfig;
} = {}) {
  return {
    loadConfigs: vi.fn(async () => ({
      jira: overrides.configuredJira ?? jiraConfig,
      repositories: {
        repositories: overrides.configuredRepositories ?? repositories
      }
    })),
    loadAuth: vi.fn(async () => lunaAuth),
    fetchIssue: vi.fn(async () => overrides.issue ?? jiraIssue)
  };
}

describe("Jira task input adapter", () => {
  it("loads a Jira task URL and returns a validated Jira invocation", async () => {
    const options = adapterOptions();

    await expect(
      fetchJiraTaskInvocation(
        "https://company.atlassian.net/browse/ABC-123",
        options
      )
    ).resolves.toEqual({
      target: "jira_task",
      workflow: "implementation",
      jira: {
        instance_id: "company",
        issue_key: "ABC-123",
        url: "https://company.atlassian.net/browse/ABC-123",
        summary: "Fix checkout validation",
        description:
          "Checkout should reject orders without a customer document.",
        acceptance_criteria: "Validation rejects missing documents.",
        status: "To Do",
        issue_type: "Task"
      },
      repository: {
        provider: "github",
        owner: "swinggo-dev",
        name: "swg-front-nuxt"
      }
    });

    expect(options.fetchIssue).toHaveBeenCalledWith({
      instance: jiraConfig.instances[0],
      auth: lunaAuth.providers.jira?.company,
      issueKey: "ABC-123"
    });
  });

  it("canonicalizes Jira task URLs without search or hash", async () => {
    const options = adapterOptions();

    await expect(
      fetchJiraTaskInvocation(
        "https://company.atlassian.net/browse/ABC-123?token=secret#details",
        options
      )
    ).resolves.toMatchObject({
      jira: {
        url: "https://company.atlassian.net/browse/ABC-123"
      }
    });
  });

  it("rejects Jira task URLs containing credentials", async () => {
    const options = adapterOptions();

    await expect(
      fetchJiraTaskInvocation(
        "https://user:password@company.atlassian.net/browse/ABC-123",
        options
      )
    ).rejects.toThrow(
      expect.objectContaining({ code: "invalid_jira_task_url" })
    );
  });

  it("throws jira_instance_not_configured for a Jira URL outside configured instances", async () => {
    const options = adapterOptions();

    await expect(
      fetchJiraTaskInvocation(
        "https://other.atlassian.net/browse/ABC-123",
        options
      )
    ).rejects.toThrow(
      expect.objectContaining({ code: "jira_instance_not_configured" })
    );
  });

  it("throws jira_repository_field_missing when the configured repository field is empty", async () => {
    const options = adapterOptions({
      issue: {
        ...jiraIssue,
        fields: {
          ...jiraIssue.fields,
          customfield_12345: undefined
        }
      }
    });

    await expect(
      fetchJiraTaskInvocation(
        "https://company.atlassian.net/browse/ABC-123",
        options
      )
    ).rejects.toThrow(
      expect.objectContaining({ code: "jira_repository_field_missing" })
    );
  });

  it("throws jira_repository_field_invalid when github_full_name is malformed", async () => {
    const options = adapterOptions({
      issue: {
        ...jiraIssue,
        fields: {
          ...jiraIssue.fields,
          customfield_12345: "swinggo-dev/not valid"
        }
      }
    });

    await expect(
      fetchJiraTaskInvocation(
        "https://company.atlassian.net/browse/ABC-123",
        options
      )
    ).rejects.toThrow(
      expect.objectContaining({ code: "jira_repository_field_invalid" })
    );
  });

  it("redacts malformed github_full_name values from error messages", async () => {
    const sensitiveRepositoryValue = "swinggo-dev/secret repo token";
    const options = adapterOptions({
      issue: {
        ...jiraIssue,
        fields: {
          ...jiraIssue.fields,
          customfield_12345: sensitiveRepositoryValue
        }
      }
    });

    await expect(
      fetchJiraTaskInvocation(
        "https://company.atlassian.net/browse/ABC-123",
        options
      )
    ).rejects.not.toThrow(sensitiveRepositoryValue);
  });

  it("throws repository_not_configured when the Jira repository is absent from repositories.yaml", async () => {
    const options = adapterOptions({ configuredRepositories: [] });

    await expect(
      fetchJiraTaskInvocation(
        "https://company.atlassian.net/browse/ABC-123",
        options
      )
    ).rejects.toThrow(
      expect.objectContaining({ code: "repository_not_configured" })
    );
  });
});
