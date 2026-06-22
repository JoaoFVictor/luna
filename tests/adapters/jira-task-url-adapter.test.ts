import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { jiraTaskUrlAdapter } from "../../src/adapters/jira-task-url/index.js";
import type { AdapterContext } from "../../src/adapters/types.js";

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
    customfield_12345: "octo-org/hello-world",
    status: {
      name: "To Do"
    },
    issuetype: {
      name: "Task"
    }
  }
};

async function writeContextFiles() {
  const configRoot = await mkdtemp(join(tmpdir(), "luna-config-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "luna-project-"));

  await writeFile(
    join(configRoot, "jira.yaml"),
    [
      "instances:",
      "  - id: company",
      "    base_url: https://company.atlassian.net",
      "    repository_hint:",
      "      source: field",
      "      field_id: customfield_12345",
      "      format: github_full_name",
      "    acceptance_criteria_field:",
      "      field_id: customfield_67890",
      "      format: markdown",
      ""
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    join(projectRoot, "luna.auth.json"),
    JSON.stringify({
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
    }),
    "utf8"
  );

  return { configRoot, projectRoot };
}

async function context(issue: unknown = jiraIssue): Promise<{
  adapterContext: AdapterContext;
  fetchMock: ReturnType<typeof vi.fn>;
}> {
  const { configRoot, projectRoot } = await writeContextFiles();
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    async json() {
      return issue;
    }
  }));

  return {
    adapterContext: {
      projectRoot,
      configRoot,
      env: {},
      fetch: fetchMock as unknown as typeof fetch,
      executeJson: vi.fn()
    },
    fetchMock
  };
}

describe("jira-task-url adapter", () => {
  it("loads a Jira task URL and resolves repository from a field hint", async () => {
    const { adapterContext, fetchMock } = await context();

    await expect(
      jiraTaskUrlAdapter.load(
        { kind: "cli", value: "https://company.atlassian.net/browse/ABC-123" },
        adapterContext
      )
    ).resolves.toEqual({
      version: "2026-06",
      source: "jira",
      event: "issue",
      action: "selected",
      repository: {
        provider: "github",
        owner: "octo-org",
        name: "hello-world"
      },
      subject: {
        type: "jira_issue",
        id: "ABC-123",
        url: "https://company.atlassian.net/browse/ABC-123",
        title: "Fix checkout validation"
      },
      payload: {
        jira: {
          instance_id: "company",
          description:
            "Checkout should reject orders without a customer document.",
          acceptance_criteria: "Validation rejects missing documents.",
          status: "To Do",
          issue_type: "Task",
          repository_hint_source: "field:customfield_12345"
        }
      }
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://company.atlassian.net/rest/api/3/issue/ABC-123"),
      {
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(
            "user@company.com:secret-token",
            "utf8"
          ).toString("base64")}`
        }
      }
    );
  });

  it("rejects Jira task URLs containing credentials", async () => {
    const { adapterContext } = await context();

    await expect(
      jiraTaskUrlAdapter.load(
        {
          kind: "cli",
          value: "https://user:password@company.atlassian.net/browse/ABC-123"
        },
        adapterContext
      )
    ).rejects.toThrow(
      expect.objectContaining({ code: "invalid_jira_issue_url" })
    );
  });

  it("throws jira_instance_not_configured for origins outside configured instances", async () => {
    const { adapterContext } = await context();

    await expect(
      jiraTaskUrlAdapter.load(
        { kind: "cli", value: "https://other.atlassian.net/browse/ABC-123" },
        adapterContext
      )
    ).rejects.toThrow(
      expect.objectContaining({ code: "jira_instance_not_configured" })
    );
  });

  it("loads a Jira task URL without repository when no field hint is present", async () => {
    const { adapterContext } = await context({
      ...jiraIssue,
      fields: {
        ...jiraIssue.fields,
        customfield_12345: undefined
      }
    });

    const result = await jiraTaskUrlAdapter.load(
      { kind: "cli", value: "https://company.atlassian.net/browse/ABC-123" },
      adapterContext
    );

    expect(result).not.toHaveProperty("repository");
  });

  it("throws jira_repository_hint_invalid when github_full_name is malformed", async () => {
    const { adapterContext } = await context({
      ...jiraIssue,
      fields: {
        ...jiraIssue.fields,
        customfield_12345: "octo-org/not valid"
      }
    });

    await expect(
      jiraTaskUrlAdapter.load(
        { kind: "cli", value: "https://company.atlassian.net/browse/ABC-123" },
        adapterContext
      )
    ).rejects.toThrow(
      expect.objectContaining({ code: "jira_repository_hint_invalid" })
    );
  });

  it("throws jira_repository_hint_invalid when repository hint uses repo prefix", async () => {
    const { adapterContext } = await context({
      ...jiraIssue,
      fields: {
        ...jiraIssue.fields,
        customfield_12345: "repo:octo-org/hello-world"
      }
    });

    await expect(
      jiraTaskUrlAdapter.load(
        { kind: "cli", value: "https://company.atlassian.net/browse/ABC-123" },
        adapterContext
      )
    ).rejects.toThrow(
      expect.objectContaining({ code: "jira_repository_hint_invalid" })
    );
  });
});
