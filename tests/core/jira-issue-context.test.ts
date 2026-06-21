import { describe, expect, it } from "vitest";
import {
  jiraIssueContextFrom,
  type JiraIssueContext
} from "../../src/core/providers/jira/task-context.js";
import type { NormalizedInvocation } from "../../src/core/invocation/types.js";

const invocation: NormalizedInvocation = {
  version: "2026-06",
  source: "jira",
  event: "issue",
  repository: {
    provider: "github",
    owner: "octo-org",
    name: "hello-world"
  },
  subject: {
    type: "jira_issue",
    id: "LUNA-123",
    url: "https://jira.example.com/browse/LUNA-123",
    title: "Add enterprise adapters"
  },
  payload: {
    jira: {
      instance_id: "luna-cloud",
      description: "Build normalized invocation contexts.",
      acceptance_criteria: "Contexts are validated before use.",
      status: "In Progress",
      issue_type: "Task"
    }
  }
};

describe("Jira issue context parser", () => {
  it("extracts normalized Jira issue context", () => {
    const expected: JiraIssueContext = {
      instanceId: "luna-cloud",
      issueKey: "LUNA-123",
      url: "https://jira.example.com/browse/LUNA-123",
      title: "Add enterprise adapters",
      description: "Build normalized invocation contexts.",
      acceptanceCriteria: "Contexts are validated before use.",
      status: "In Progress",
      issueType: "Task",
      repository: invocation.repository!
    };

    expect(jiraIssueContextFrom(invocation)).toEqual(expected);
  });

  it("allows empty acceptance criteria when Jira config has no acceptance field", () => {
    expect(
      jiraIssueContextFrom({
        ...invocation,
        payload: {
          jira: {
            ...(invocation.payload?.jira as Record<string, unknown>),
            acceptance_criteria: ""
          }
        }
      }).acceptanceCriteria
    ).toBe("");
  });

  it("preserves the generic missing payload error code", () => {
    expect(() =>
      jiraIssueContextFrom({
        ...invocation,
        payload: undefined
      })
    ).toThrow(expect.objectContaining({ code: "invocation_payload_missing" }));
  });
});
