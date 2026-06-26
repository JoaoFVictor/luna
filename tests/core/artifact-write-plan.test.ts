import { describe, expect, it, vi } from "vitest";
import {
  normalizeArtifactWritePlans,
  writePlannedArtifacts
} from "../../src/core/workflow/artifact-write-plan.js";
import type { SchedulerWorkflowState } from "../../src/core/workflow/state.js";

function workflowState(steps: Record<string, unknown> = {}): SchedulerWorkflowState {
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
      flue_run_id: "flue-run-1",
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
  plans: Parameters<typeof normalizeArtifactWritePlans>[1],
  uses = "preflight"
) {
  return {
    id,
    type: "built_in" as const,
    uses,
    artifacts: normalizeArtifactWritePlans(id, plans, new Set([id]))
  };
}

function artifactPlan(
  path: string,
  source: string,
  format: "json" | "markdown" = "json",
  required?: boolean
): NonNullable<Parameters<typeof normalizeArtifactWritePlans>[1]>[number] {
  return {
    path,
    publisher: "artifacts.manifest_publisher",
    source: { expression: source },
    format,
    ...(required === undefined ? {} : { required })
  };
}

function artifactStoreMock() {
  return {
    writeJson: vi.fn(async (name: string) => name),
    writeMarkdown: vi.fn(async (name: string) => name)
  };
}

describe("artifact write plans", () => {
  it("skips optional missing artifact sources and errors for required missing sources", async () => {
    const artifactStore = artifactStoreMock();
    const node = builtInArtifactNode("preflight", [
      artifactPlan("optional.json", "$.steps.preflight.optional", "json", false)
    ]);

    await writePlannedArtifacts({
      artifactStore,
      node,
      output: { present: true },
      state: workflowState()
    });

    expect(artifactStore.writeJson).not.toHaveBeenCalled();

    const requiredNode = builtInArtifactNode("preflight", [
      artifactPlan("required.json", "$.steps.preflight.required")
    ]);

    await expect(
      writePlannedArtifacts({
        artifactStore,
        node: requiredNode,
        output: { present: true },
        state: workflowState()
      })
    ).rejects.toMatchObject({ code: "workflow_artifact_source_missing" });
  });

  it("requires markdown artifacts to resolve to strings", async () => {
    const artifactStore = artifactStoreMock();
    const node = builtInArtifactNode(
      "final_report",
      [
        artifactPlan("final-report.md", "$.steps.final_report.markdown", "markdown")
      ],
      "final_code_review_report"
    );

    await expect(
      writePlannedArtifacts({
        artifactStore,
        node,
        output: { markdown: { not: "a string" } },
        state: workflowState()
      })
    ).rejects.toMatchObject({ code: "workflow_artifact_string_required" });
  });

  it("rejects non-JSON values for json artifacts", async () => {
    const artifactStore = artifactStoreMock();
    const node = builtInArtifactNode("preflight", [
      artifactPlan("output.json", "$.steps.preflight")
    ]);

    await expect(
      writePlannedArtifacts({
        artifactStore,
        node,
        output: { bad: undefined },
        state: workflowState()
      })
    ).rejects.toMatchObject({ code: "artifact_json_value_invalid" });
  });

  it("resolves current node output before scheduler persists it in state steps", async () => {
    const artifactStore = artifactStoreMock();
    const node = builtInArtifactNode("preflight", [
      artifactPlan("preflight.json", "$.steps.preflight")
    ]);

    await writePlannedArtifacts({
      artifactStore,
      node,
      output: { ok: true },
      state: workflowState()
    });

    expect(artifactStore.writeJson).toHaveBeenCalledWith("preflight.json", {
      ok: true
    });
  });

  it("writes declared artifact plans in deterministic order", async () => {
    const artifactWritePlan: string[] = [];
    const artifactStore = {
      writeJson: vi.fn(async (name: string) => {
        artifactWritePlan.push(name);
        return name;
      }),
      writeMarkdown: vi.fn(async (name: string) => {
        artifactWritePlan.push(name);
        return name;
      })
    };
    const node = builtInArtifactNode("final_report", [
      artifactPlan("summary.json", "$.steps.final_report.summary"),
      artifactPlan("details.json", "$.steps.final_report.details"),
      artifactPlan("final-report.md", "$.steps.final_report.markdown", "markdown")
    ]);

    await writePlannedArtifacts({
      artifactStore,
      node,
      output: {
        summary: { ok: true },
        details: { count: 2 },
        markdown: "# Report"
      },
      state: workflowState()
    });

    const expectedDeterministicOrder = [
      "summary.json",
      "details.json",
      "final-report.md"
    ];
    expect(artifactWritePlan).toEqual(expectedDeterministicOrder);
  });
});
