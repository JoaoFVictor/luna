import { describe, expect, it, vi } from "vitest";
import { manifest } from "../../../src/capabilities/artifacts/manifest.js";
import {
  transactionalArtifactPublisher,
  publishDeclaredArtifacts,
  type ArtifactPublisherPort
} from "../../../src/capabilities/artifacts/publisher.js";
import { matchesJsonSchema } from "../../../src/core/capabilities/json-schema.js";
import type {
  ArtifactContentCommitInput,
  ArtifactContentWriteInput,
  ArtifactTransactionJournal,
  ArtifactTransactionRecord
} from "../../../src/core/runtime/artifacts/transaction.js";
import type { ArtifactManifest } from "../../../src/core/runtime/artifacts/contracts.js";
import type { WorkflowRuntimeState } from "../../../src/core/workflow/state.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";

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
  plans: ReturnType<typeof artifactPlan>[],
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

function journal(): ArtifactTransactionJournal {
  const records = new Map<string, ArtifactTransactionRecord>();
  return {
    async get(transactionId) {
      return records.get(transactionId);
    },
    async put(record) {
      records.set(record.transaction_id, record);
    }
  };
}

function contentStore() {
  return {
    async write(input: ArtifactContentWriteInput) {
      return {
        pending_uri: `pending://${input.transaction_id}`,
        content_hash: input.content_hash
      };
    },
    async commit(input: ArtifactContentCommitInput) {
      return {
        uri: `artifact://${input.run_id}/${input.artifact_path}`,
        content_hash: input.content_hash
      };
    }
  };
}

function transactionalPublisher() {
  const published: ArtifactManifest[] = [];
  const checkpointed: ArtifactManifest[] = [];
  return {
    published,
    checkpointed,
    publisher: transactionalArtifactPublisher({
      run_id: "run-1",
      backend: {
        id: "memory.artifacts",
        root: "artifacts"
      },
      manifestStore: createMemoryArtifactManifestStore(),
      transactionJournal: journal(),
      contentStore: contentStore(),
      stepsPublisher: {
        async publishArtifactRef(ref) {
          published.push(ref);
        }
      },
      checkpointMarker: {
        async markArtifactCheckpointed(ref) {
          checkpointed.push(ref);
        }
      },
      now: () => "2026-06-26T00:00:00.000Z"
    })
  };
}

describe("artifacts capability publisher", () => {
  it("rejects unsafe paths and artifact sources outside the declaring node", async () => {
    await expect(
      publishDeclaredArtifacts({
        publisher: publisherMock(),
        node: builtInArtifactNode("plan", [
          artifactPlan("../plan.json", "$.steps.plan")
        ]),
        output: { ok: true },
        state: workflowState()
      })
    ).rejects.toMatchObject({ code: "path_security_violation" });

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

  it("keeps manifest publisher overwrite policy explicit and forbids duplicate declared paths", async () => {
    expect(
      manifest.artifact_publishers?.["artifacts.manifest_publisher"]
    ).toMatchObject({
      overwrite_policy: "forbid",
      manifest_transaction: "required"
    });

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

    await expect(
      publishDeclaredArtifacts({
        publisher: publisherMock(),
        node: builtInArtifactNode("report", [
          artifactPlan("versioned.json", "$.steps.report", "json", true, {
            overwrite_policy: "version"
          })
        ]),
        output: { ok: true },
        state: workflowState()
      })
    ).rejects.toMatchObject({ code: "artifact_overwrite_policy_unsupported" });
  });

  it("skips optional missing artifact sources and errors for required missing sources", async () => {
    const publisher = publisherMock();
    const node = builtInArtifactNode("preflight", [
      artifactPlan("optional.json", "$.steps.preflight.optional", "json", false)
    ]);

    await publishDeclaredArtifacts({
      publisher,
      node,
      output: { present: true },
      state: workflowState()
    });

    expect(publisher.publish).not.toHaveBeenCalled();

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

  it("writes declared artifact plans in deterministic order and validates publisher output", async () => {
    const artifactWritePlan: string[] = [];
    const publisher = publisherMock(vi.fn(async (input) => {
      artifactWritePlan.push(input.path);
      return {
        id: input.path,
        uri: `artifact://${input.path}`,
        node_id: input.node_id,
        media_type: input.format === "json" ? "application/json" : "text/markdown"
      };
    }));
    const node = builtInArtifactNode("final_report", [
      artifactPlan("summary.json", "$.steps.final_report.summary"),
      artifactPlan("details.json", "$.steps.final_report.details"),
      artifactPlan("final-report.md", "$.steps.final_report.markdown", "markdown")
    ]);

    const output = await publishDeclaredArtifacts({
      publisher,
      node,
      output: {
        summary: { ok: true },
        details: { count: 2 },
        markdown: "# Report"
      },
      state: workflowState()
    });

    expect(artifactWritePlan).toEqual([
      "summary.json",
      "details.json",
      "final-report.md"
    ]);
    expect(
      matchesJsonSchema(
        manifest.schemas?.["artifacts.publisher_output"]?.schema,
        output
      )
    ).toBe(true);
  });

  it("can publish through artifact transactions with explicit overwrite behavior", async () => {
    const tx = transactionalPublisher();
    const node = builtInArtifactNode("report", [
      artifactPlan("report.json", "$.steps.report")
    ]);

    const first = await publishDeclaredArtifacts({
      publisher: tx.publisher,
      node,
      output: { ok: true },
      state: workflowState()
    });

    await expect(
      publishDeclaredArtifacts({
        publisher: tx.publisher,
        node,
        output: { ok: false },
        state: workflowState()
      })
    ).rejects.toMatchObject({ code: "artifact_content_conflict" });

    expect(first.artifacts[0]).toMatchObject({
      id: "report.json",
      uri: "artifact://run-1/report.json",
      node_id: "report"
    });
    expect(tx.published.map((ref) => ref.id)).toEqual(["report.json"]);
    expect(tx.checkpointed.map((ref) => ref.id)).toEqual(["report.json"]);
  });
});
