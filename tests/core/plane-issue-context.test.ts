import { describe, expect, it } from "vitest";
import {
  planeIssueKey,
  planeIssueContextFrom,
  type PlaneIssueContext
} from "../../src/providers/plane/task-context.js";
import type { NormalizedInvocation } from "../../src/core/router/invocation.js";

const invocation: NormalizedInvocation = {
  version: "2026-06",
  source: "plane",
  event: "issue",
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
      description: "Reject invalid checkout payloads.",
      status: "Backlog",
      priority: "high",
      labels: ["bug"]
    }
  }
};

const browseInvocation: NormalizedInvocation = {
  ...invocation,
  subject: {
    type: "plane_issue",
    id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
    url: "https://app.plane.so/company/browse/PROJ-42/",
    title: "Fix checkout validation"
  },
  payload: {
    plane: {
      instance_id: "company",
      workspace_slug: "company",
      project_identifier: "PROJ",
      issue_identifier: 42,
      issue_id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
      sequence_id: 42,
      description: "Reject invalid checkout payloads.",
      status: "Backlog",
      priority: "high",
      labels: ["bug"]
    }
  }
};

describe("Plane issue context parser", () => {
  it("extracts normalized Plane issue context", () => {
    const expected: PlaneIssueContext = {
      kind: "project_issue",
      instanceId: "company",
      workspaceSlug: "company",
      projectId: "24f9b7",
      issueId: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
      sequenceId: 42,
      url: "https://app.plane.so/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
      title: "Fix checkout validation",
      description: "Reject invalid checkout payloads.",
      status: "Backlog",
      priority: "high",
      labels: ["bug"],
      repository: invocation.repository!
    };

    expect(planeIssueContextFrom(invocation)).toEqual(expected);
  });

  it("extracts Plane issue context without repository", () => {
    const context = planeIssueContextFrom({
      ...invocation,
      repository: undefined
    });

    expect(context.repository).toBeUndefined();
    expect(context.issueId).toBe("b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984");
  });

  it("extracts Plane browse issue context", () => {
    const context = planeIssueContextFrom(browseInvocation);

    expect(context).toMatchObject({
      kind: "work_item",
      projectIdentifier: "PROJ",
      issueIdentifier: 42,
      issueId: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984"
    });
    expect("projectId" in context).toBe(false);
    expect(planeIssueKey(context)).toBe("PROJ-42");
  });

  it("preserves the generic missing payload error code", () => {
    expect(() =>
      planeIssueContextFrom({
        ...invocation,
        payload: undefined
      })
    ).toThrow(expect.objectContaining({ code: "invocation_payload_missing" }));
  });
});
