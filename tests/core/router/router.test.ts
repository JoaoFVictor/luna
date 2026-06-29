import { describe, expect, it } from "vitest";
import {
  parseWorkflowTarget,
  routeInvocation
} from "../../../src/core/router/router.js";
import { RouterDefinitionSchema, type RouterDefinition } from "../../../src/core/router/router-definition.js";
import type { InvocationEnvelope } from "../../../src/core/router/invocation.js";

const githubPullRequest = {
  version: "2026-06",
  source: "github",
  event: "pull_request",
  action: "opened"
} satisfies InvocationEnvelope;

const routingConfig = {
  type: "router",
  version: "2026-06",
  rules: [
    {
      id: "explicit_target",
      when: { expression: "$exists($.invocation.target)" },
      target: "$.invocation.target"
    },
    {
      id: "github_pr_code_review",
      when: {
        expression:
          "$.invocation.source = 'github' and $.invocation.event = 'pull_request' and $.invocation.action in ['selected', 'opened', 'synchronize', 'reopened']"
      },
      target: "workflow:code-review"
    },
    {
      id: "jira_issue_implementation",
      when: {
        expression:
          "$.invocation.source = 'jira' and $.invocation.event = 'issue' and $.invocation.action = 'selected'"
      },
      target: "workflow:implementation"
    },
    {
      id: "plane_issue_implementation",
      when: {
        expression:
          "$.invocation.source = 'plane' and $.invocation.event = 'issue' and $.invocation.action in ['selected', 'create', 'update']"
      },
      target: "workflow:implementation"
    }
  ]
} satisfies RouterDefinition;

describe("declarative router", () => {
  it("rejects duplicate rule ids", () => {
    expect(() =>
      RouterDefinitionSchema.parse({
        type: "router",
        version: "2026-06",
        rules: [
          {
            id: "dupe",
            when: { expression: "true" },
            target: "workflow:code-review"
          },
          {
            id: "dupe",
            when: { expression: "true" },
            target: "workflow:implementation"
          }
        ]
      })
    ).toThrow();
  });

  it("routes deterministically with the first matching JSONata rule", async () => {
    await expect(routeInvocation(githubPullRequest, routingConfig)).resolves.toEqual({
      type: "workflow",
      id: "code-review"
    });
  });

  it("routes webhook Plane issue actions to implementation", async () => {
    await expect(
      routeInvocation(
        { version: "2026-06", source: "plane", event: "issue", action: "create" },
        routingConfig
      )
    ).resolves.toEqual({ type: "workflow", id: "implementation" });

    await expect(
      routeInvocation(
        { version: "2026-06", source: "plane", event: "issue", action: "update" },
        routingConfig
      )
    ).resolves.toEqual({ type: "workflow", id: "implementation" });
  });

  it("does not route Plane issue delete webhooks", async () => {
    await expect(
      routeInvocation(
        { version: "2026-06", source: "plane", event: "issue", action: "delete" },
        routingConfig
      )
    ).rejects.toMatchObject({ code: "router_no_match" });
  });

  it("uses an explicit invocation target through declarative YAML", async () => {
    await expect(
      routeInvocation(
        {
          ...githubPullRequest,
          target: { type: "workflow", id: "manual-review" }
        },
        routingConfig
      )
    ).resolves.toEqual({ type: "workflow", id: "manual-review" });
  });

  it("fails with explicit no-match and expression errors that include rule paths", async () => {
    await expect(
      routeInvocation(
        { version: "2026-06", source: "github", event: "issue" },
        routingConfig
      )
    ).rejects.toMatchObject({ code: "router_no_match" });

    await expect(
      routeInvocation(githubPullRequest, {
        type: "router",
        version: "2026-06",
        rules: [
          {
            id: "broken",
            when: { expression: "$notAFunction(" },
            target: "workflow:code-review"
          }
        ]
      })
    ).rejects.toMatchObject({
      code: "router_expression_failed",
      path: "$.rules[0].when.expression"
    });
  });

  it("parses workflow string targets only", () => {
    expect(parseWorkflowTarget("workflow:implementation")).toEqual({
      type: "workflow",
      id: "implementation"
    });
    expect(() => parseWorkflowTarget("implementation")).toThrow(
      expect.objectContaining({ code: "router_invalid_target" })
    );
    expect(() => parseWorkflowTarget("workflow:bad/id")).toThrow(
      expect.objectContaining({ code: "router_invalid_target" })
    );
  });
});
