import { describe, expect, it, vi } from "vitest";
import { routeInvocation } from "../../src/core/router.js";
import type { RoutingConfig } from "../../src/core/types.js";

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
        event_in: ["pull_request.opened"]
      },
      target: {
        type: "workflow",
        id: "code-review"
      }
    }
  ]
};

describe("router", () => {
  it("uses explicit input target when a route has has_target true", () => {
    const target = {
      type: "workflow",
      id: "manual-review"
    };

    expect(
      routeInvocation(
        { source: "manual", event: "dispatch", target },
        routingConfig
      )
    ).toEqual(target);
  });

  it("throws invalid_invocation for incomplete invocations with explicit target", () => {
    expect(() =>
      routeInvocation(
        { target: { type: "workflow", id: "manual-review" } },
        routingConfig
      )
    ).toThrow(expect.objectContaining({ code: "invalid_invocation" }));
  });

  it("throws invalid_target for invalid explicit targets", () => {
    expect(() =>
      routeInvocation(
        {
          source: "manual",
          event: "dispatch",
          target: { type: "agent", id: "manual-review" }
        },
        routingConfig
      )
    ).toThrow(expect.objectContaining({ code: "invalid_target" }));
  });

  it("routes GitHub pull_request.opened to workflow code-review", () => {
    expect(
      routeInvocation(
        { source: "github", event: "pull_request.opened" },
        routingConfig
      )
    ).toEqual({ type: "workflow", id: "code-review" });
  });

  it("throws no_route_matched for unmatched input", () => {
    expect(() =>
      routeInvocation(
        { source: "github", event: "issues.opened" },
        routingConfig
      )
    ).toThrow(expect.objectContaining({ code: "no_route_matched" }));
  });

  it("does not call a model or any async callback while routing", () => {
    const modelCall = vi.fn(async () => "called");
    const asyncCallback = vi.fn(async () => "called");

    const result = routeInvocation(
      {
        source: "github",
        event: "pull_request.opened",
        modelCall,
        asyncCallback
      },
      routingConfig
    );

    expect(result).toEqual({ type: "workflow", id: "code-review" });
    expect(result).not.toBeInstanceOf(Promise);
    expect(modelCall).not.toHaveBeenCalled();
    expect(asyncCallback).not.toHaveBeenCalled();
  });
});
