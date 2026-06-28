import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { jiraTaskUrlAdapter } from "../../src/providers/jira/input-adapter.js";
import type { AdapterContext } from "../../src/adapters/types.js";

const jiraIssue = {
  key: "ABC-123",
  fields: {
    summary: "Fix checkout validation",
    customfield_12345: "github:octo-org/hello-world"
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
      "    acceptance_criteria_field:",
      "      field_id: customfield_67890",
      "      format: markdown",
      ""
    ].join("\n"),
    "utf8"
  );

  const authRoot = join(projectRoot, ".luna", "auth");
  await mkdir(authRoot, { recursive: true });
  await writeFile(
    join(authRoot, "luna.auth.json"),
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
    const { adapterContext } = await context();

    await expect(
      jiraTaskUrlAdapter.load(
        { kind: "cli", value: "https://company.atlassian.net/browse/ABC-123" },
        adapterContext
      )
    ).resolves.toMatchObject({
      source: "jira",
      repository: {
        provider: "github",
        owner: "octo-org",
        name: "hello-world"
      },
      subject: {
        type: "jira_issue",
        id: "ABC-123"
      }
    });

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

  it("throws jira_repository_hint_invalid when repository hint omits provider prefix", async () => {
    const { adapterContext } = await context({
      ...jiraIssue,
      fields: {
        ...jiraIssue.fields,
        customfield_12345: "octo-org/hello-world"
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
