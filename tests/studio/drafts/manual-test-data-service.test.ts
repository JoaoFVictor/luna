import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../../../src/core/json/value.js";
import { sha256Digest } from "../../../src/core/workflow/definition-digests.js";
import { StudioDraftTestDataService } from "../../../src/studio/application/drafts/manual-test-data-service.js";
import { studioRunLaunchError } from "../../../src/studio/application/runs/launch-errors.js";
import type { RunNodeOutputService } from "../../../src/studio/application/runs/node-output-service.js";
import type { StudioDraftItem } from "../../../src/studio/contracts/draft-authoring.js";
import { RunRecordSchema, type RunRecord } from "../../../src/studio/contracts/runs.js";

const DRAFT_ID = "15956bef-49cb-4c8b-acc2-bd189fb9d3b3";
const ETAG = `"studio-draft:${DRAFT_ID}:3:fixture"`;
const WORKFLOW_REVISION = `sha256:${"a".repeat(64)}`;
const BUNDLE_HASH = `sha256:${"b".repeat(64)}`;
const GRAPH_HASH = `sha256:${"c".repeat(64)}`;
const OUTCOME_HASH = `sha256:${"d".repeat(64)}`;
const EXECUTION_HASH = `sha256:${"e".repeat(64)}`;
const CATALOG_HASH = `sha256:${"f".repeat(64)}`;
const SOURCE_ETAG = `"studio-draft:${DRAFT_ID}:2:source"`;
const CAPTURED_AT = "2026-07-11T10:00:03.000Z";

function source(overrides: Record<string, unknown> = {}) {
  return {
    kind: "run_node_output",
    run_id: "run-manual-data-1",
    workflow_id: "code-review",
    node_id: "review",
    graph_hash: GRAPH_HASH,
    outcome_hash: OUTCOME_HASH,
    workflow_revision: WORKFLOW_REVISION,
    definition_bundle_hash: BUNDLE_HASH,
    captured_at: CAPTURED_AT,
    redaction_changed: false,
    definition_source: {
      kind: "draft",
      draft_id: DRAFT_ID,
      etag: SOURCE_ETAG
    },
    ...overrides
  };
}

function draft(options: {
  readonly output?: JsonValue;
  readonly source?: ReturnType<typeof source>;
  readonly kind?: "workflow" | "agent";
} = {}): StudioDraftItem {
  return {
    draft_id: DRAFT_ID,
    record_revision: 3,
    content_revision: 1,
    layout_revision: 2,
    primary_resource: {
      kind: options.kind ?? "workflow",
      id: "code-review"
    },
    status: "valid",
    draft_hash: WORKFLOW_REVISION,
    etag: ETAG,
    files: [],
    layout: {
      workflow: {
        expression_fixtures: {
          approved: {
            invocation: { ignored: true },
            config: { ignored: true },
            steps: { review: options.output ?? { summary: "approved" } },
            workspace: { ignored: true }
          }
        },
        expression_fixture_sources: {
          approved: options.source ?? source()
        }
      }
    },
    created_at: "2026-07-11T09:00:00.000Z",
    updated_at: "2026-07-11T10:01:00.000Z"
  };
}

function record(overrides: Record<string, unknown> = {}): RunRecord {
  return RunRecordSchema.parse({
    schema_version: 1,
    record_revision: 4,
    run_id: "run-manual-data-1",
    workflow_id: "code-review",
    definition_source: {
      kind: "draft",
      draft_id: DRAFT_ID,
      etag: SOURCE_ETAG
    },
    workflow_revision: WORKFLOW_REVISION,
    definition_bundle_hash: BUNDLE_HASH,
    catalog_fingerprint: CATALOG_HASH,
    execution_snapshot_hash: EXECUTION_HASH,
    dispatch_status: "started",
    run_status: "succeeded",
    created_at: "2026-07-11T10:00:00.000Z",
    updated_at: CAPTURED_AT,
    started_at: "2026-07-11T10:00:01.000Z",
    finished_at: CAPTURED_AT,
    owner_id: "worker-1",
    owner_claimed_at: "2026-07-11T10:00:00.500Z",
    heartbeat_at: "2026-07-11T10:00:02.000Z",
    active_node_ids: [],
    artifact_count: 0,
    interrupt_count: 0,
    side_effects: [],
    completeness: "complete",
    ...overrides
  });
}

function definitions(overrides: {
  readonly workflowId?: string;
  readonly workflowRevision?: string;
  readonly definitionBundleHash?: string;
} = {}) {
  return {
    loadDraft: vi.fn(async () => ({
      workflowId: overrides.workflowId ?? "code-review",
      workflowRevision: overrides.workflowRevision ?? WORKFLOW_REVISION,
      definitionBundleHash: overrides.definitionBundleHash ?? BUNDLE_HASH,
      config: {}
    })),
    validateDraftNodeOutput: vi.fn(async () => undefined)
  };
}

function outputs(options: {
  readonly value?: JsonValue;
  readonly changed?: boolean;
  readonly record?: RunRecord;
  readonly graphHash?: string;
  readonly outcomeHash?: string;
  readonly available?: boolean;
  readonly nodeId?: string;
} = {}) {
  const sourceRecord = options.record ?? record();
  return {
    getWithRecord: vi.fn(async () => options.available === false
      ? {
          response: {
            schema_version: 1 as const,
            availability: "unavailable" as const,
            run: {
              run_id: sourceRecord.run_id,
              workflow_id: sourceRecord.workflow_id,
              workflow_revision: WORKFLOW_REVISION,
              definition_bundle_hash: BUNDLE_HASH,
              execution_snapshot_hash: EXECUTION_HASH,
              status: "succeeded" as const,
              completeness: "complete" as const
            },
            node_id: options.nodeId ?? "review",
            reason: "output_not_recorded" as const
          },
          record: sourceRecord
        }
      : {
          response: {
            schema_version: 1 as const,
            availability: "available" as const,
            run: {
              run_id: sourceRecord.run_id,
              workflow_id: sourceRecord.workflow_id,
              workflow_revision: sourceRecord.workflow_revision,
              definition_bundle_hash: sourceRecord.definition_bundle_hash,
              execution_snapshot_hash: sourceRecord.execution_snapshot_hash,
              status: "succeeded" as const,
              completeness: "complete" as const
            },
            node_id: options.nodeId ?? "review",
            graph_hash: options.graphHash ?? GRAPH_HASH,
            outcome_hash: options.outcomeHash ?? OUTCOME_HASH,
            output: {
              availability: "available" as const,
              value: options.value ?? { summary: "approved" },
              redaction: {
                mode: "best_effort" as const,
                changed: options.changed ?? false
              }
            }
          },
          record: sourceRecord
        })
  } satisfies Pick<RunNodeOutputService, "getWithRecord">;
}

function service(options: {
  readonly current?: StudioDraftItem;
  readonly definitions?: ReturnType<typeof definitions>;
  readonly outputs?: ReturnType<typeof outputs>;
} = {}) {
  const current = options.current ?? draft();
  const definitionPort = options.definitions ?? definitions();
  const outputPort = options.outputs ?? outputs();
  const drafts = { get: vi.fn(async () => current) };
  return {
    drafts,
    definitions: definitionPort,
    outputs: outputPort,
    subject: new StudioDraftTestDataService({
      drafts,
      definitions: definitionPort,
      outputs: outputPort
    })
  };
}

describe("StudioDraftTestDataService", () => {
  it("authorizes the exact edited output while anchoring it to the original run output", async () => {
    const original = { summary: "approved", score: 10 };
    const edited = { summary: "manual branch", score: 7 };
    const current = draft({
      output: edited,
      source: source({
        kind: "edited_run_node_output",
        source_output_hash: sha256Digest(original),
        output_hash: sha256Digest(edited),
        edited_at: "2026-07-11T10:02:00.000Z"
      })
    });
    const fixture = service({
      current,
      outputs: outputs({ value: original })
    });

    const authorized = await fixture.subject.authorize(
      DRAFT_ID,
      { fixture_name: "approved" },
      ETAG
    );

    expect(authorized[0]?.output).toEqual(edited);
    expect(fixture.definitions.validateDraftNodeOutput).toHaveBeenCalledWith(
      { kind: "draft", draft_id: DRAFT_ID, etag: ETAG },
      "review",
      edited
    );
  });

  it("reauthorizes one exact fixture and returns only its bounded node output", async () => {
    const fixture = service();

    await expect(fixture.subject.authorize(
      DRAFT_ID,
      { fixture_name: "approved" },
      ETAG
    )).resolves.toEqual([{
      kind: "draft_fixture",
      fixture_name: "approved",
      node_id: "review",
      output: { summary: "approved" },
      output_hash: sha256Digest({ summary: "approved" }),
      source: source()
    }]);
    expect(fixture.definitions.loadDraft).toHaveBeenCalledWith({
      kind: "draft",
      draft_id: DRAFT_ID,
      etag: ETAG
    });
    expect(fixture.outputs.getWithRecord).toHaveBeenCalledWith(
      "run-manual-data-1",
      "review"
    );
  });

  it("authorizes multiple fixtures atomically and returns canonical node order", async () => {
    const secondSource = source({
      run_id: "run-manual-data-2",
      node_id: "aggregate"
    });
    const current = draft();
    const workflow = (current.layout as Record<string, JsonValue>)
      .workflow as Record<string, JsonValue>;
    workflow.expression_fixtures = {
      approved: (workflow.expression_fixtures as Record<string, JsonValue>).approved,
      aggregate: { steps: { aggregate: { total: 2 } } }
    };
    workflow.expression_fixture_sources = {
      approved: (workflow.expression_fixture_sources as Record<string, JsonValue>).approved,
      aggregate: secondSource
    };
    const firstOutput = outputs();
    const secondOutput = outputs({
      value: { total: 2 },
      nodeId: "aggregate",
      record: record({ run_id: "run-manual-data-2" })
    });
    const outputPort = {
      getWithRecord: vi.fn(async (runId: string, nodeId: string) =>
        runId === "run-manual-data-2"
          ? await secondOutput.getWithRecord()
          : await firstOutput.getWithRecord()
      )
    } satisfies Pick<RunNodeOutputService, "getWithRecord">;
    const fixture = service({ current, outputs: outputPort });

    const authorized = await fixture.subject.authorize(DRAFT_ID, [
      { fixture_name: "approved" },
      { fixture_name: "aggregate" }
    ], ETAG);

    expect(authorized.map((entry) => entry.node_id)).toEqual([
      "aggregate",
      "review"
    ]);
    expect(fixture.drafts.get).toHaveBeenCalledTimes(1);
    expect(fixture.definitions.loadDraft).toHaveBeenCalledTimes(1);
    expect(outputPort.getWithRecord).toHaveBeenCalledTimes(2);
  });

  it("rejects two fixtures for the same node before private output reads", async () => {
    const current = draft();
    const workflow = (current.layout as Record<string, JsonValue>)
      .workflow as Record<string, JsonValue>;
    workflow.expression_fixtures = {
      approved: (workflow.expression_fixtures as Record<string, JsonValue>).approved,
      duplicate: { steps: { review: { summary: "duplicate" } } }
    };
    workflow.expression_fixture_sources = {
      approved: (workflow.expression_fixture_sources as Record<string, JsonValue>).approved,
      duplicate: source({ run_id: "run-manual-data-2" })
    };
    const fixture = service({ current });

    await expect(fixture.subject.authorize(DRAFT_ID, [
      { fixture_name: "approved" },
      { fixture_name: "duplicate" }
    ], ETAG)).rejects.toMatchObject({
      code: "studio_draft_test_data_invalid",
      details: { fixtureName: "duplicate", nodeId: "review" }
    });
    expect(fixture.definitions.loadDraft).not.toHaveBeenCalled();
    expect(fixture.outputs.getWithRecord).not.toHaveBeenCalled();
  });

  it("rejects missing and stale ETags before definition or output reads", async () => {
    const fixture = service();

    await expect(fixture.subject.authorize(
      DRAFT_ID,
      { fixture_name: "approved" },
      undefined
    )).rejects.toMatchObject({
      code: "studio_draft_test_data_precondition_required"
    });
    await expect(fixture.subject.authorize(
      DRAFT_ID,
      { fixture_name: "approved" },
      `"stale"`
    )).rejects.toMatchObject({
      code: "studio_draft_test_data_precondition_failed"
    });
    expect(fixture.definitions.loadDraft).not.toHaveBeenCalled();
    expect(fixture.outputs.getWithRecord).not.toHaveBeenCalled();
  });

  it("rejects historical definition revisions before reading private output", async () => {
    const definitionPort = definitions({
      workflowRevision: `sha256:${"9".repeat(64)}`
    });
    const fixture = service({ definitions: definitionPort });

    await expect(fixture.subject.authorize(
      DRAFT_ID,
      { fixture_name: "approved" },
      ETAG
    )).rejects.toMatchObject({
      code: "studio_draft_test_data_definition_mismatch"
    });
    expect(fixture.outputs.getWithRecord).not.toHaveBeenCalled();
  });

  it("reports a draft race as stale without reading private output", async () => {
    const definitionPort = definitions();
    definitionPort.loadDraft.mockRejectedValueOnce(studioRunLaunchError(
      "studio_run_plan_stale",
      "Draft changed"
    ));
    const fixture = service({ definitions: definitionPort });

    await expect(fixture.subject.authorize(
      DRAFT_ID,
      { fixture_name: "approved" },
      ETAG
    )).rejects.toMatchObject({ code: "studio_draft_test_data_stale" });
    expect(fixture.outputs.getWithRecord).not.toHaveBeenCalled();
  });

  it("rejects redacted and unavailable source outputs", async () => {
    const redactedStored = service({
      current: draft({ source: source({ redaction_changed: true }) })
    });
    await expect(redactedStored.subject.authorize(
      DRAFT_ID,
      { fixture_name: "approved" },
      ETAG
    )).rejects.toMatchObject({ code: "studio_draft_test_data_invalid" });
    expect(redactedStored.outputs.getWithRecord).not.toHaveBeenCalled();

    const redactedCurrent = service({ outputs: outputs({ changed: true }) });
    await expect(redactedCurrent.subject.authorize(
      DRAFT_ID,
      { fixture_name: "approved" },
      ETAG
    )).rejects.toMatchObject({ code: "studio_draft_test_data_invalid" });

    const unavailable = service({ outputs: outputs({ available: false }) });
    await expect(unavailable.subject.authorize(
      DRAFT_ID,
      { fixture_name: "approved" },
      ETAG
    )).rejects.toMatchObject({ code: "studio_draft_test_data_unavailable" });
  });

  it("rejects stale identity metadata and fixture value tampering", async () => {
    const stale = service({
      outputs: outputs({ graphHash: `sha256:${"0".repeat(64)}` })
    });
    await expect(stale.subject.authorize(
      DRAFT_ID,
      { fixture_name: "approved" },
      ETAG
    )).rejects.toMatchObject({ code: "studio_draft_test_data_stale" });

    const tampered = service({
      current: draft({ output: { summary: "tampered" } })
    });
    await expect(tampered.subject.authorize(
      DRAFT_ID,
      { fixture_name: "approved" },
      ETAG
    )).rejects.toMatchObject({ code: "studio_draft_test_data_tampered" });
  });

  it("applies the manual-data bound to the reauthorized output", async () => {
    const fixture = service({
      outputs: outputs({ value: { report: "x".repeat(140 * 1_024) } })
    });

    await expect(fixture.subject.authorize(
      DRAFT_ID,
      { fixture_name: "approved" },
      ETAG
    )).rejects.toMatchObject({ code: "studio_draft_test_data_too_large" });
  });
});
