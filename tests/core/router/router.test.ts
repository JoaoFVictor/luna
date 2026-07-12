import { describe, expect, it } from "vitest";
import {
  decideInvocationRoute,
  parseWorkflowTarget,
  routeInvocation
} from "../../../src/core/router/router.js";
import {
  ROUTER_DEFINITION_MAX_RULES,
  ROUTER_RULE_EXPRESSION_MAX_LENGTH,
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

  it("bounds rule count and JSONata expression length", () => {
    const rules = Array.from(
      { length: ROUTER_DEFINITION_MAX_RULES + 1 },
      (_, index) => ({
        id: `rule-${index}`,
        when: { expression: "true" },
        target: "workflow:code-review"
      })
    );

    expect(
      RouterDefinitionSchema.safeParse({
        type: "router",
        version: "2026-06",
        rules
      }).success
    ).toBe(false);
    expect(
      RouterDefinitionSchema.safeParse({
        type: "router",
        version: "2026-06",
        rules: [
          {
            id: "oversized-expression",
            when: {
              expression: "x".repeat(ROUTER_RULE_EXPRESSION_MAX_LENGTH + 1)
            },
            target: "workflow:code-review"
          }
        ]
      }).success
    ).toBe(false);
  });

  it("routes deterministically with the first matching JSONata rule", async () => {
    await expect(routeInvocation(githubPullRequest, routingConfig)).resolves.toEqual({
      type: "workflow",
      id: "code-review"
    });
  });

  it("returns the canonical detailed decision without observer callbacks", async () => {
    const decision = await decideInvocationRoute(githubPullRequest, routingConfig);

    expect(decision).toMatchObject({
      outcome: "matched",
      target: { type: "workflow", id: "code-review" },
      matchedRule: { ruleIndex: 1, ruleId: "github_pr_code_review" },
      evaluations: [
        { outcome: "boolean", ruleIndex: 0, result: false },
        { outcome: "boolean", ruleIndex: 1, result: true }
      ]
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

  it("keeps failed evaluations in the canonical detailed decision", async () => {
    const decision = await decideInvocationRoute(githubPullRequest, {
      type: "router",
      version: "2026-06",
      rules: [
        {
          id: "broken",
          when: { expression: "$notAFunction(" },
          target: "workflow:code-review"
        }
      ]
    });

    expect(decision).toMatchObject({
      outcome: "error",
      error: { code: "router_expression_failed" },
      evaluations: [
        {
          outcome: "error",
          ruleIndex: 0,
          ruleId: "broken",
          error: { code: "router_expression_failed" }
        }
      ]
    });
  });

  it("never exposes JSONata error messages or oversized invocation secrets", async () => {
    const secret = `do-not-expose-${"x".repeat(100_000)}`;
    const decision = await decideInvocationRoute({
      ...githubPullRequest,
      payload: { secret }
    }, {
      type: "router",
      version: "2026-06",
      rules: [
        {
          id: "secret-error",
          when: { expression: "$error($.invocation.payload.secret)" },
          target: "workflow:code-review"
        }
      ]
    });

    expect(decision.outcome).toBe("error");
    if (decision.outcome !== "error") {
      throw new Error("Expected the route decision to fail");
    }
    expect(decision.error).toMatchObject({
      code: "router_expression_failed",
      message: "Router expression failed at $.rules[0].when.expression."
    });
    expect(decision.error.message).not.toContain("do-not-expose");
    expect(decision.error.message.length).toBeLessThan(128);
    expect(decision.error).not.toHaveProperty("cause");
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
