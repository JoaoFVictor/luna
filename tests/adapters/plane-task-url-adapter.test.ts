import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { planeTaskUrlAdapter } from "../../src/adapters/plane-task-url/index.js";
import type { AdapterContext } from "../../src/adapters/types.js";

const planeIssue = {
  id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
  sequence_id: 42,
  name: "Fix checkout validation",
  description_stripped:
    "Checkout should reject orders without a customer document.",
  priority: "high",
  state: {
    name: "Backlog"
  },
  labels: [
    {
      name: "bug"
    }
  ]
};

async function writeContextFiles() {
  const configRoot = await mkdtemp(join(tmpdir(), "luna-config-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "luna-project-"));

  await writeFile(
    join(configRoot, "plane.yaml"),
    [
      "instances:",
      "  - id: company",
      "    base_url: https://app.plane.so",
      "    repository_hint:",
      "      source: label",
      "      format: github_full_name",
      ""
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    join(projectRoot, "luna.auth.json"),
    JSON.stringify({
      providers: {
        plane: {
          company: {
            base_url: "https://app.plane.so",
            auth_type: "api_key",
            api_key: "secret-token"
          }
        }
      }
    }),
    "utf8"
  );

  return { configRoot, projectRoot };
}

async function context(issue: unknown = planeIssue): Promise<{
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

describe("plane-task-url adapter", () => {
  it("loads a Plane browse URL by work item identifier", async () => {
    const issue = {
      ...planeIssue,
      labels: [{ name: "github:octo-org/hello-world" }, { name: "bug" }]
    };
    const { adapterContext, fetchMock } = await context(issue);

    await expect(
      planeTaskUrlAdapter.load(
        {
          kind: "cli",
          value: "https://app.plane.so/company/browse/PROJ-42/"
        },
        adapterContext
      )
    ).resolves.toMatchObject({
      version: "2026-06",
      source: "plane",
      event: "issue",
      action: "selected",
      repository: {
        provider: "github",
        owner: "octo-org",
        name: "hello-world"
      },
      subject: {
        type: "plane_issue",
        id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
        url: "https://app.plane.so/company/browse/PROJ-42",
        title: "Fix checkout validation"
      },
      payload: {
        plane: expect.objectContaining({
          workspace_slug: "company",
          project_identifier: "PROJ",
          issue_identifier: 42,
          repository_hint_source: "label:github:octo-org/hello-world"
        })
      }
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://api.plane.so/api/v1/workspaces/company/work-items/PROJ-42/"),
      {
        headers: {
          Accept: "application/json",
          "X-API-Key": "secret-token"
        }
      }
    );
  });

  it("loads a Plane task URL and resolves repository from a label hint", async () => {
    const issue = {
      ...planeIssue,
      labels: [{ name: "github:octo-org/hello-world" }, { name: "bug" }]
    };
    const { adapterContext, fetchMock } = await context(issue);

    await expect(
      planeTaskUrlAdapter.load(
        {
          kind: "cli",
          value:
            "https://app.plane.so/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984"
        },
        adapterContext
      )
    ).resolves.toEqual({
      version: "2026-06",
      source: "plane",
      event: "issue",
      action: "selected",
      repository: {
        provider: "github",
        owner: "octo-org",
        name: "hello-world"
      },
      subject: {
        type: "plane_issue",
        id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
        url: "https://app.plane.so/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
        title: "Fix checkout validation"
      },
      payload: {
        plane: {
          instance_id: "company",
          workspace_slug: "company",
          project_id: "24f9b7",
          issue_id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
          sequence_id: 42,
          description:
            "Checkout should reject orders without a customer document.",
          status: "Backlog",
          priority: "high",
          labels: ["github:octo-org/hello-world", "bug"],
          repository_hint_source: "label:github:octo-org/hello-world"
        }
      }
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        "https://api.plane.so/api/v1/workspaces/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984"
      ),
      {
        headers: {
          Accept: "application/json",
          "X-API-Key": "secret-token"
        }
      }
    );
  });

  it("loads a Plane task URL without repository when no label hint is present", async () => {
    const { adapterContext, fetchMock } = await context();

    await expect(
      planeTaskUrlAdapter.load(
        {
          kind: "cli",
          value:
            "https://app.plane.so/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984"
        },
        adapterContext
      )
    ).resolves.toEqual({
      version: "2026-06",
      source: "plane",
      event: "issue",
      action: "selected",
      subject: {
        type: "plane_issue",
        id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
        url: "https://app.plane.so/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
        title: "Fix checkout validation"
      },
      payload: {
        plane: {
          instance_id: "company",
          workspace_slug: "company",
          project_id: "24f9b7",
          issue_id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
          sequence_id: 42,
          description:
            "Checkout should reject orders without a customer document.",
          status: "Backlog",
          priority: "high",
          labels: ["bug"]
        }
      }
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        "https://api.plane.so/api/v1/workspaces/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984"
      ),
      {
        headers: {
          Accept: "application/json",
          "X-API-Key": "secret-token"
        }
      }
    );
  });

  it("ignores non-repository Plane labels that contain slashes", async () => {
    const { adapterContext } = await context({
      ...planeIssue,
      labels: [{ name: "area/frontend" }, { name: "bug" }]
    });

    await expect(
      planeTaskUrlAdapter.load(
        {
          kind: "cli",
          value:
            "https://app.plane.so/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984"
        },
        adapterContext
      )
    ).resolves.not.toHaveProperty("repository");
  });

  it("rejects repo-prefixed labels because github is the only repository hint prefix", async () => {
    const { adapterContext } = await context({
      ...planeIssue,
      labels: [{ name: "repo:octo-org/hello-world" }, { name: "bug" }]
    });

    await expect(
      planeTaskUrlAdapter.load(
        {
          kind: "cli",
          value:
            "https://app.plane.so/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984"
        },
        adapterContext
      )
    ).rejects.toThrow(
      expect.objectContaining({ code: "plane_repository_hint_invalid" })
    );
  });

  it("rejects Plane task URLs containing credentials", async () => {
    const { adapterContext } = await context();

    await expect(
      planeTaskUrlAdapter.load(
        {
          kind: "cli",
          value: "https://user:password@app.plane.so/company/projects/abc/issues/def"
        },
        adapterContext
      )
    ).rejects.toThrow(
      expect.objectContaining({ code: "invalid_plane_task_url" })
    );
  });

  it("throws plane_issue_invalid_response when Plane returns an unsupported payload", async () => {
    const { adapterContext } = await context({ id: "", name: "" });

    await expect(
      planeTaskUrlAdapter.load(
        {
          kind: "cli",
          value:
            "https://app.plane.so/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984"
        },
        adapterContext
      )
    ).rejects.toThrow(
      expect.objectContaining({ code: "plane_issue_invalid_response" })
    );
  });

  it("throws plane_issue_invalid_response when Plane returns non-JSON content", async () => {
    const { adapterContext } = await context();
    adapterContext.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new SyntaxError("Unexpected token '<'");
      }
    })) as unknown as typeof fetch;

    await expect(
      planeTaskUrlAdapter.load(
        {
          kind: "cli",
          value: "https://app.plane.so/company/browse/PROJ-42/"
        },
        adapterContext
      )
    ).rejects.toThrow(
      expect.objectContaining({ code: "plane_issue_invalid_response" })
    );
  });
});
