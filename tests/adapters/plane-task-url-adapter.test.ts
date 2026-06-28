import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { planeTaskUrlAdapter } from "../../src/providers/plane/input-adapter.js";
import type { AdapterContext } from "../../src/adapters/types.js";

const planeIssue = {
  id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
  name: "Fix checkout validation",
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
      ""
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    join(configRoot, "luna.auth.json"),
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
    const { adapterContext } = await context(issue);

    await expect(
      planeTaskUrlAdapter.load(
        {
          kind: "cli",
          value: "https://app.plane.so/company/browse/PROJ-42/"
        },
        adapterContext
      )
    ).resolves.toMatchObject({
      source: "plane",
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
          issue_identifier: 42
        })
      }
    });

  });

  it("loads a Plane project issue URL", async () => {
    const { adapterContext } = await context();

    await expect(
      planeTaskUrlAdapter.load(
        {
          kind: "cli",
          value:
            "https://app.plane.so/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984"
        },
        adapterContext
      )
    ).resolves.toMatchObject({
      source: "plane",
      subject: {
        type: "plane_issue",
        id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984"
      },
      payload: {
        plane: {
          workspace_slug: "company",
          project_id: "24f9b7"
        }
      }
    });
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
