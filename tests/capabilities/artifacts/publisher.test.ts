import { describe, expect, it, vi } from "vitest";
import {
  publishDeclaredArtifacts,
  type ArtifactPublisherPort
} from "../../../src/capabilities/artifacts/publisher.js";
import type { WorkflowRuntimeState } from "../../../src/core/workflow/state.js";

function workflowState(steps: Record<string, unknown> = {}): WorkflowRuntimeState {
  return {
    invocation: {
      version: "2026-06",
      source: "json",
      event: "manual",
      payload: {}
    },
    config: {},
    run: {
      run_id: "run-1",
      workflow_id: "code-review",
      runtime_run_id: "runtime-run-1",
      attempt: 1,
      source: "json",
      event: "manual",
      started_at: "2026-06-20T00:00:00.000Z"
    },
    workflow: {
      id: "code-review",
      mode: "read_only"
    },
    workspaceRoot: "/tmp/luna-workspaces",
    agentsRoot: "/tmp/luna-agents",
    steps
  };
}

function builtInArtifactNode(
  id: string,
  plans: Array<ReturnType<typeof artifactPlan> & { semantic_type?: string }>,
  uses = "preflight"
) {
  return {
    id,
    type: "built_in" as const,
    uses,
    artifacts: plans.map((plan) => ({
      path: plan.path,
      source: plan.source.expression,
      format: plan.format,
      required: plan.required ?? true,
      ...(plan.semantic_type === undefined
        ? {}
        : { semantic_type: plan.semantic_type }),
      ...(plan.config === undefined ? {} : { config: plan.config })
    }))
  };
}

function artifactPlan(
  path: string,
  source: string,
  format: "json" | "markdown" = "json",
  required?: boolean,
  config?: Record<string, unknown>
): {
  path: string;
  publisher: string;
  source: { expression: string };
  format: "json" | "markdown";
  required?: boolean;
  config?: Record<string, unknown>;
} {
  return {
    path,
    publisher: "artifacts.manifest_publisher",
    source: { expression: source },
    format,
    ...(required === undefined ? {} : { required }),
    ...(config === undefined ? {} : { config })
  };
}

function publisherMock(
  publish = vi.fn(async (input) => ({
    id: input.path,
    uri: `artifact://${input.path}`,
    node_id: input.node_id,
    media_type: input.format === "json" ? "application/json" : "text/markdown"
  }))
): ArtifactPublisherPort & { publish: typeof publish } {
  return { publish };
}

describe("artifacts capability publisher", () => {
  it("rejects artifact sources outside the declaring node", async () => {
    await expect(
      publishDeclaredArtifacts({
        publisher: publisherMock(),
        node: builtInArtifactNode("plan", [
          artifactPlan("plan.json", "$.steps.other")
        ]),
        output: { ok: true },
        state: workflowState({ other: { ok: false } })
      })
    ).rejects.toMatchObject({ code: "workflow_artifact_source_wrong_step" });
  });

  it("forbids duplicate declared artifact paths", async () => {
    await expect(
      publishDeclaredArtifacts({
        publisher: publisherMock(),
        node: builtInArtifactNode("report", [
          artifactPlan("report.json", "$.steps.report"),
          artifactPlan("report.json", "$.steps.report")
        ]),
        output: { ok: true },
        state: workflowState()
      })
    ).rejects.toMatchObject({ code: "workflow_artifact_path_duplicate" });

  });

  it("validates every declaration before publishing the first artifact", async () => {
    const publisher = publisherMock();

    await expect(
      publishDeclaredArtifacts({
        publisher,
        node: builtInArtifactNode("report", [
          artifactPlan("report.json", "$.steps.report"),
          artifactPlan("../escape.json", "$.steps.report")
        ]),
        output: { ok: true },
        state: workflowState()
      })
    ).rejects.toBeDefined();

    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("errors for required missing artifact sources", async () => {
    const publisher = publisherMock();
    const requiredNode = builtInArtifactNode("preflight", [
      artifactPlan("required.json", "$.steps.preflight.required")
    ]);

    await expect(
      publishDeclaredArtifacts({
        publisher,
        node: requiredNode,
        output: { present: true },
        state: workflowState()
      })
    ).rejects.toMatchObject({ code: "workflow_artifact_source_missing" });
  });

  it("requires markdown artifacts to resolve to strings", async () => {
    const node = builtInArtifactNode(
      "final_report",
      [
        artifactPlan("final-report.md", "$.steps.final_report.markdown", "markdown")
      ],
      "final_code_review_report"
    );

    await expect(
      publishDeclaredArtifacts({
        publisher: publisherMock(),
        node,
        output: { markdown: { not: "a string" } },
        state: workflowState()
      })
    ).rejects.toMatchObject({ code: "workflow_artifact_string_required" });
  });

  it("rejects non-JSON values for json artifacts", async () => {
    const node = builtInArtifactNode("preflight", [
      artifactPlan("output.json", "$.steps.preflight")
    ]);

    await expect(
      publishDeclaredArtifacts({
        publisher: publisherMock(),
        node,
        output: { bad: undefined },
        state: workflowState()
      })
    ).rejects.toMatchObject({ code: "artifact_json_value_invalid" });
  });

  it("resolves current node output before scheduler persists it in state steps", async () => {
    const publisher = publisherMock();
    const node = builtInArtifactNode("preflight", [
      artifactPlan("preflight.json", "$.steps.preflight")
    ]);

    await publishDeclaredArtifacts({
      publisher,
      node,
      output: { ok: true },
      state: workflowState()
    });

    expect(publisher.publish).toHaveBeenCalledWith({
      node_id: "preflight",
      path: "preflight.json",
      format: "json",
      value: { ok: true },
      overwrite_policy: "forbid"
    });
  });

  it("passes declared semantic metadata to the publisher without adding it to payload", async () => {
    const publisher = publisherMock();
    const node = builtInArtifactNode("preflight", [
      {
        ...artifactPlan("preflight.json", "$.steps.preflight"),
        semantic_type: "luna.review.findings.v1"
      }
    ]);

    await publishDeclaredArtifacts({
      publisher,
      node,
      output: { ok: true },
      state: workflowState()
    });

    expect(publisher.publish).toHaveBeenCalledWith({
      node_id: "preflight",
      path: "preflight.json",
      format: "json",
      value: { ok: true },
      semantic_type: "luna.review.findings.v1",
      overwrite_policy: "forbid"
    });
  });

});
