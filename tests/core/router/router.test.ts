import { describe, expect, it, vi } from "vitest";
import {
  parseWorkflowTarget,
  routeInvocation
} from "../../../src/core/router/router.js";
import {
  RouterDefinitionSchema,
  type RouterDefinition
} from "../../../src/core/router/router-definition.js";
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
      id: "github_pr_review",
      when: {
        expression:
          "$.invocation.source = 'github' and $.invocation.event = 'pull_request'"
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
    }
  ]
} satisfies RouterDefinition;

describe("declarative router", () => {
  it("validates the router YAML shape", () => {
    expect(RouterDefinitionSchema.parse(routingConfig)).toEqual(routingConfig);
  });

  it("rejects duplicate rule ids and invalid targets", () => {
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

    expect(() =>
      RouterDefinitionSchema.parse({
        type: "router",
        version: "2026-06",
        rules: [
          {
            id: "bad",
            when: { expression: "true" },
            target: "agent:reviewer"
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

  it("does not call a model or async payload callback while routing", async () => {
    const modelCall = vi.fn(async () => "called");
    const asyncCallback = vi.fn(async () => "called");

    const result = await routeInvocation(
      {
        ...githubPullRequest,
        payload: {
          modelCall,
          asyncCallback
        }
      },
      routingConfig
    );

    expect(result).toEqual({ type: "workflow", id: "code-review" });
    expect(modelCall).not.toHaveBeenCalled();
    expect(asyncCallback).not.toHaveBeenCalled();
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
