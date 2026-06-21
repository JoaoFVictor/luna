import { describe, expect, it, vi } from "vitest";
import { routeInvocation } from "../../src/core/invocation/router.js";
import {
  RoutingConfigSchema,
  type RoutingConfig
} from "../../src/core/invocation/types.js";

const routingConfig: RoutingConfig = {
  routes: [
    {
      name: "explicit-target",
      when: {
        has_target: true
      },
      use_target_from_input: true
    },
    {
      name: "github-pr-code-review",
      when: {
        source: "github",
        event: "pull_request",
        action_in: ["selected", "opened", "synchronize", "reopened"]
      },
      target: {
        type: "workflow",
        id: "code-review"
      }
    },
    {
      name: "jira-issue-implementation",
      when: {
        source: "jira",
        event: "issue",
        action: "selected"
      },
      target: {
        type: "workflow",
        id: "implementation"
      }
    }
  ]
};

describe("router", () => {
  it("accepts the planned routing config shape", () => {
    expect(RoutingConfigSchema.parse(routingConfig)).toEqual(routingConfig);
  });

  it("rejects routes with conflicting scalar and list matchers", () => {
    expect(() =>
      RoutingConfigSchema.parse({
        routes: [
          {
            name: "conflicting-events",
            when: {
              source: "github",
              event: "pull_request",
              event_in: ["issues"]
            },
            target: {
              type: "workflow",
              id: "code-review"
            }
          }
        ]
      })
    ).toThrow();

    expect(() =>
      RoutingConfigSchema.parse({
        routes: [
          {
            name: "conflicting-actions",
            when: {
              source: "github",
              event: "pull_request",
              action: "opened",
              action_in: ["reopened"]
            },
            target: {
              type: "workflow",
              id: "code-review"
            }
          }
        ]
      })
    ).toThrow();
  });

  it("uses explicit input target when a route has has_target true", () => {
    const target = {
      type: "workflow",
      id: "manual-review"
    } as const;

    expect(
      routeInvocation(
        { version: "2026-06", source: "manual", event: "dispatch", target },
        routingConfig
      )
    ).toEqual(target);
  });

  it("throws invalid_target for invalid explicit targets", () => {
    expect(() =>
      routeInvocation(
        {
          version: "2026-06",
          source: "manual",
          event: "dispatch",
          target: { type: "agent", id: "manual-review" } as never
        },
        routingConfig
      )
    ).toThrow(expect.objectContaining({ code: "invalid_target" }));
  });

  it("routes GitHub pull_request opened action to workflow code-review", () => {
    expect(
      routeInvocation(
        {
          version: "2026-06",
          source: "github",
          event: "pull_request",
          action: "opened"
        },
        routingConfig
      )
    ).toEqual({ type: "workflow", id: "code-review" });
  });

  it("routes Jira issue selected action to workflow implementation", () => {
    expect(
      routeInvocation(
        {
          version: "2026-06",
          source: "jira",
          event: "issue",
          action: "selected"
        },
        routingConfig
      )
    ).toEqual({ type: "workflow", id: "implementation" });
  });

  it("throws no_route_matched for unmatched input", () => {
    expect(() =>
      routeInvocation(
        { version: "2026-06", source: "github", event: "issues" },
        routingConfig
      )
    ).toThrow(expect.objectContaining({ code: "no_route_matched" }));
  });

  it("does not call a model or any async callback while routing", () => {
    const modelCall = vi.fn(async () => "called");
    const asyncCallback = vi.fn(async () => "called");

    const result = routeInvocation(
      {
        version: "2026-06",
        source: "github",
        event: "pull_request",
        action: "selected",
        payload: {
          modelCall,
          asyncCallback
        }
      },
      routingConfig
    );

    expect(result).toEqual({ type: "workflow", id: "code-review" });
    expect(result).not.toBeInstanceOf(Promise);
    expect(modelCall).not.toHaveBeenCalled();
    expect(asyncCallback).not.toHaveBeenCalled();
  });
});
