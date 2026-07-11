import { describe, expect, it } from "vitest";
import { defineInputAdapters } from "../../../src/adapters/registry.js";
import type { RegisteredInputAdapter } from "../../../src/adapters/types.js";
import type {
  Invocation,
  InvocationEnvelope
} from "../../../src/core/router/invocation.js";
import {
  ROUTER_DEFINITION_MAX_RULES,
  type RouterDefinition
} from "../../../src/core/router/router-definition.js";
import { defineStudioAdapterPreviewPort } from "../../../src/studio/application/inputs/adapter-preview-port.js";
import { previewStudioInputAdapter } from "../../../src/studio/application/inputs/input-adapters.js";
import { simulateStudioRouting } from "../../../src/studio/application/routing/routing-simulator.js";
import {
  STUDIO_INVOCATION_PAYLOAD_MAX_BYTES,
  STUDIO_INVOCATION_PAYLOAD_MAX_ENTRIES,
  STUDIO_ROUTING_DIAGNOSTIC_MESSAGE_MAX_LENGTH,
  StudioInvocationSchema,
  StudioRoutingDiagnosticSchema,
  StudioRoutingSimulationSchema
} from "../../../src/studio/contracts/input-routing.js";

const routing = {
  type: "router",
  version: "2026-06",
  rules: [
    {
      id: "explicit_target",
      when: { expression: "$exists($.invocation.target)" },
      target: "$.invocation.target"
    },
    {
      id: "github_pull_request",
      when: {
        expression:
          "$.invocation.source = 'github' and $.invocation.event = 'pull_request'"
      },
      target: "workflow:code-review"
    },
    {
      id: "task_issue",
      when: {
        expression:
          "$.invocation.source in ['jira', 'plane'] and $.invocation.event = 'issue'"
      },
      target: "workflow:implementation"
    }
  ]
} satisfies RouterDefinition;

function fixedAdapter(
  id: string,
  invocation: Invocation
): RegisteredInputAdapter {
  return {
    id,
    description: `Fake ${id} adapter`,
    source: invocation.source,
    async load() {
      return invocation;
    }
  };
}

describe("Studio routing simulator", () => {
  it("bounds simulation payload size and top-level entries", () => {
    const invocation = {
      version: "2026-06",
      source: "manual",
      event: "simulate"
    } as const;

    expect(
      StudioInvocationSchema.safeParse({
        ...invocation,
        payload: {
          oversized: "x".repeat(STUDIO_INVOCATION_PAYLOAD_MAX_BYTES)
        }
      }).success
    ).toBe(false);
    expect(
      StudioInvocationSchema.safeParse({
        ...invocation,
        payload: Object.fromEntries(
          Array.from(
            { length: STUDIO_INVOCATION_PAYLOAD_MAX_ENTRIES + 1 },
            (_, index) => [`key-${index}`, null]
          )
        )
      }).success
    ).toBe(false);
  });

  it("bounds routing evaluations, diagnostics, and numeric indices", () => {
    const evaluation = {
      rule_id: "bounded",
      rule_index: 0,
      expression_path: "$.rules[0].when.expression",
      outcome: "boolean",
      result: false
    } as const;
    const diagnostic = {
      severity: "warning",
      code: "router_no_match",
      message: "No router rule matched invocation."
    } as const;

    expect(
      StudioRoutingSimulationSchema.safeParse({
        status: "no_match",
        evaluations: Array.from(
          { length: ROUTER_DEFINITION_MAX_RULES + 1 },
          () => evaluation
        ),
        matched_rule: null,
        target: null,
        diagnostics: []
      }).success
    ).toBe(false);
    expect(
      StudioRoutingSimulationSchema.safeParse({
        status: "no_match",
        evaluations: [],
        matched_rule: null,
        target: null,
        diagnostics: Array.from(
          { length: ROUTER_DEFINITION_MAX_RULES + 1 },
          () => diagnostic
        )
      }).success
    ).toBe(false);
    expect(
      StudioRoutingDiagnosticSchema.safeParse({
        ...diagnostic,
        message: "x".repeat(
          STUDIO_ROUTING_DIAGNOSTIC_MESSAGE_MAX_LENGTH + 1
        )
      }).success
    ).toBe(false);
    expect(
      StudioRoutingDiagnosticSchema.safeParse({
        ...diagnostic,
        rule_index: Number.MAX_SAFE_INTEGER + 1
      }).success
    ).toBe(false);
  });

  it.each([
    {
      source: "github",
      event: "pull_request",
      ruleId: "github_pull_request",
      workflowId: "code-review"
    },
    {
      source: "jira",
      event: "issue",
      ruleId: "task_issue",
      workflowId: "implementation"
    },
    {
      source: "plane",
      event: "issue",
      ruleId: "task_issue",
      workflowId: "implementation"
    }
  ])("routes $source by invocation.source", async ({
    source,
    event,
    ruleId,
    workflowId
  }) => {
    const simulation = await simulateStudioRouting(
      { invocation: { version: "2026-06", source, event } },
      routing
    );

    expect(simulation).toMatchObject({
      status: "matched",
      matched_rule: { rule_id: ruleId },
      target: { type: "workflow", id: workflowId },
      diagnostics: []
    });
    expect(simulation.evaluations.at(-1)).toMatchObject({
      rule_id: ruleId,
      outcome: "boolean",
      result: true
    });
  });

  it("uses an explicit invocation target and stops at the first matching rule", async () => {
    const simulation = await simulateStudioRouting(
      {
        invocation: {
          version: "2026-06",
          source: "manual",
          event: "launch",
          target: { type: "workflow", id: "manual-review" }
        }
      },
      routing
    );

    expect(simulation).toMatchObject({
      status: "matched",
      matched_rule: { rule_id: "explicit_target", rule_index: 0 },
      target: { type: "workflow", id: "manual-review" }
    });
    expect(simulation.evaluations).toHaveLength(1);
  });

  it("returns a structured warning without starting anything on no-match", async () => {
    const simulation = await simulateStudioRouting(
      {
        invocation: {
          version: "2026-06",
          source: "github",
          event: "issue"
        }
      },
      routing
    );

    expect(simulation).toMatchObject({
      status: "no_match",
      matched_rule: null,
      target: null,
      diagnostics: [
        {
          severity: "warning",
          code: "router_no_match"
        }
      ]
    });
    expect(simulation.evaluations).toHaveLength(routing.rules.length);
  });

  it("returns the failed rule and structured expression diagnostics", async () => {
    const brokenRouting = {
      type: "router",
      version: "2026-06",
      rules: [
        {
          id: "broken",
          when: { expression: "$notAFunction(" },
          target: "workflow:implementation"
        }
      ]
    } satisfies RouterDefinition;
    const simulation = await simulateStudioRouting(
      {
        invocation: {
          version: "2026-06",
          source: "plane",
          event: "issue"
        }
      },
      brokenRouting
    );

    expect(simulation).toMatchObject({
      status: "error",
      matched_rule: null,
      target: null,
      evaluations: [
        {
          rule_id: "broken",
          rule_index: 0,
          outcome: "error",
          diagnostic: {
            code: "router_expression_failed",
            path: "$.rules[0].when.expression"
          }
        }
      ],
      diagnostics: [
        {
          code: "router_expression_failed",
          rule_id: "broken",
          rule_index: 0
        }
      ]
    });
  });

  it("cannot distinguish adapter ids when their normalized envelopes are equal", async () => {
    const invocation = {
      version: "2026-06",
      source: "jira",
      event: "issue",
      action: "selected"
    } satisfies InvocationEnvelope;
    const first = fixedAdapter("jira-primary", invocation);
    const second = fixedAdapter("jira-alias", invocation);
    const registry = defineInputAdapters([first, second]);
    const previews = defineStudioAdapterPreviewPort(registry, [
      {
        adapterId: first.id,
        effects: [],
        timeoutMs: 1_000,
        preview: async () => invocation
      },
      {
        adapterId: second.id,
        effects: [],
        timeoutMs: 1_000,
        preview: async () => invocation
      }
    ]);
    const firstPreview = await previewStudioInputAdapter(
      {
        adapter_id: first.id,
        input: { kind: "cli", value: "first opaque value" },
        acknowledged_effects: []
      },
      { registry, previews }
    );
    const secondPreview = await previewStudioInputAdapter(
      {
        adapter_id: second.id,
        input: { kind: "cli", value: "second opaque value" },
        acknowledged_effects: []
      },
      { registry, previews }
    );

    expect(firstPreview.adapter_id).not.toBe(secondPreview.adapter_id);
    expect(firstPreview.invocation).toEqual(secondPreview.invocation);
    const [firstSimulation, secondSimulation] = await Promise.all([
      simulateStudioRouting({ invocation: firstPreview.invocation }, routing),
      simulateStudioRouting({ invocation: secondPreview.invocation }, routing)
    ]);

    expect(firstSimulation).toEqual(secondSimulation);
  });
});
