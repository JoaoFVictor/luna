import { describe, expect, it, vi } from "vitest";
import { StudioRunOutputFixtureService } from "../../../src/studio/application/drafts/run-output-fixture-service.js";
import type { StudioDraftAuthoringService } from "../../../src/studio/application/drafts/authoring-service.js";
import type { RunNodeOutputService } from "../../../src/studio/application/runs/node-output-service.js";
import type { StudioDraftItem } from "../../../src/studio/contracts/draft-authoring.js";
import type { StudioDraftPatchRequest } from "../../../src/studio/contracts/draft-authoring.js";
import type { JsonValue } from "../../../src/core/json/value.js";
import { sha256Digest } from "../../../src/core/workflow/definition-digests.js";
import {
  workflowExpressionFixtureSources,
  workflowExpressionFixtures
} from "../../../src/studio/contracts/workflow-expression-fixtures.js";
import { RunRecordSchema, type RunRecord } from "../../../src/studio/contracts/runs.js";

const DRAFT_ID = "15956bef-49cb-4c8b-acc2-bd189fb9d3b3";
const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;

function record(draftId = DRAFT_ID): RunRecord {
  return RunRecordSchema.parse({
    schema_version: 1,
    record_revision: 4,
    run_id: "run-fixture-1",
    workflow_id: "code-review",
    definition_source: { kind: "draft", draft_id: draftId, etag: `"source"` },
    workflow_revision: DIGEST,
    definition_bundle_hash: DIGEST,
    catalog_fingerprint: DIGEST,
    execution_snapshot_hash: DIGEST,
    dispatch_status: "started",
    run_status: "succeeded",
    created_at: "2026-07-11T10:00:00.000Z",
    updated_at: "2026-07-11T10:00:03.000Z",
    started_at: "2026-07-11T10:00:01.000Z",
    finished_at: "2026-07-11T10:00:03.000Z",
    owner_id: "worker-1",
    owner_claimed_at: "2026-07-11T10:00:00.500Z",
    heartbeat_at: "2026-07-11T10:00:02.000Z",
    active_node_ids: [],
    artifact_count: 0,
    interrupt_count: 0,
    side_effects: [],
    completeness: "complete"
  });
}

function draft(): StudioDraftItem {
  return {
    draft_id: DRAFT_ID,
    record_revision: 2,
    content_revision: 1,
    layout_revision: 1,
    primary_resource: { kind: "workflow", id: "code-review" },
    status: "valid",
    draft_hash: DIGEST,
    etag: `"studio-draft:${DRAFT_ID}:2:${DIGEST}"`,
    files: [],
    layout: { workflow: { direction: "vertical" } },
    created_at: "2026-07-11T09:00:00.000Z",
    updated_at: "2026-07-11T09:01:00.000Z"
  };
}

function draftWithLegacyFixtureSource(): StudioDraftItem {
  return {
    ...draft(),
    record_revision: 7,
    layout_revision: 6,
    etag: `"studio-draft:${DRAFT_ID}:7:${DIGEST}"`,
    layout: {
      workflow: {
        direction: "vertical",
        expression_fixtures: {
          "legacy-preview": {
            invocation: {},
            config: {},
            steps: { review: { summary: "older result" } },
            workspace: {}
          }
        },
        expression_fixture_sources: {
          "legacy-preview": {
            kind: "run_node_output",
            run_id: "run-fixture-older",
            workflow_id: "code-review",
            node_id: "review",
            graph_hash: DIGEST,
            outcome_hash: DIGEST,
            redaction_changed: false,
            definition_source: {
              kind: "draft",
              draft_id: DRAFT_ID,
              etag: `"studio-draft:${DRAFT_ID}:1:${DIGEST}"`
            }
          }
        }
      }
    }
  };
}

function output(
  value: JsonValue = { summary: "approved" },
  sourceRecord: RunRecord = record(),
  redactionChanged = true
) {
  return {
    getWithRecord: vi.fn(async () => ({
      response: {
        schema_version: 1 as const,
        availability: "available" as const,
        run: {
          run_id: "run-fixture-1",
          workflow_id: "code-review",
          workflow_revision: DIGEST,
          definition_bundle_hash: DIGEST,
          execution_snapshot_hash: DIGEST,
          status: "succeeded" as const,
          completeness: "complete" as const
        },
        node_id: "review",
        graph_hash: DIGEST,
        outcome_hash: DIGEST,
        output: {
          availability: "available" as const,
          value,
          redaction: { mode: "best_effort" as const, changed: redactionChanged }
        }
      },
      record: sourceRecord
    }))
  } satisfies Pick<RunNodeOutputService, "getWithRecord">;
}

function pinnedDraft(): StudioDraftItem {
  const current = draft();
  return {
    ...current,
    layout: {
      workflow: {
        expression_fixtures: {
          approved: {
            invocation: {},
            config: {},
            steps: { review: { summary: "approved" } },
            workspace: {}
          }
        },
        expression_fixture_sources: {
          approved: {
            kind: "run_node_output",
            run_id: "run-fixture-1",
            workflow_id: "code-review",
            node_id: "review",
            graph_hash: DIGEST,
            outcome_hash: DIGEST,
            workflow_revision: DIGEST,
            definition_bundle_hash: DIGEST,
            captured_at: "2026-07-11T10:00:03.000Z",
            redaction_changed: false,
            definition_source: {
              kind: "draft",
              draft_id: DRAFT_ID,
              etag: `"source"`
            }
          }
        }
      }
    }
  };
}

function writer(current = draft()) {
  const patch = vi.fn(async (
    _draftId: string,
    _input: StudioDraftPatchRequest,
    _ifMatch: string | undefined
  ) => current);
  return {
    get: vi.fn(async () => current),
    patch
  } satisfies Pick<StudioDraftAuthoringService, "get" | "patch">;
}

describe("StudioRunOutputFixtureService", () => {
  it("edits a pinned output with server hashes, source provenance, and schema validation", async () => {
    const current = pinnedDraft();
    const drafts = writer(current);
    const validator = { validateDraftNodeOutput: vi.fn(async () => undefined) };
    const service = new StudioRunOutputFixtureService({
      outputs: output({ summary: "approved" }, record(), false),
      drafts,
      validator
    });

    await service.edit(DRAFT_ID, {
      fixture_name: "approved",
      output: { summary: "edited", score: 9 }
    }, current.etag);

    expect(validator.validateDraftNodeOutput).toHaveBeenCalledWith(
      { kind: "draft", draft_id: DRAFT_ID, etag: current.etag },
      "review",
      { summary: "edited", score: 9 }
    );
    const [, patch] = drafts.patch.mock.calls[0] ?? [];
    expect(workflowExpressionFixtures(patch?.layout).approved).toEqual({
      invocation: {},
      config: {},
      steps: { review: { summary: "edited", score: 9 } },
      workspace: {}
    });
    expect(workflowExpressionFixtureSources(patch?.layout).approved).toMatchObject({
      kind: "edited_run_node_output",
      source_output_hash: sha256Digest({ summary: "approved" }),
      output_hash: sha256Digest({ summary: "edited", score: 9 }),
      redaction_changed: false
    });
  });

  it("rejects credentials in edited executable output", async () => {
    const current = pinnedDraft();
    const drafts = writer(current);
    const service = new StudioRunOutputFixtureService({
      outputs: output({ summary: "approved" }, record(), false),
      drafts,
      validator: { validateDraftNodeOutput: vi.fn(async () => undefined) }
    });

    await expect(service.edit(DRAFT_ID, {
      fixture_name: "approved",
      output: { authorization: "Bearer super-secret-token" }
    }, current.etag)).rejects.toMatchObject({
      code: "studio_draft_authoring_fixture_conflict"
    });
    expect(drafts.patch).not.toHaveBeenCalled();
  });

  it("despins authorization while preserving the fixture for preview", async () => {
    const current = pinnedDraft();
    const drafts = writer(current);
    const service = new StudioRunOutputFixtureService({ outputs: output(), drafts });

    await service.despin(DRAFT_ID, { fixture_name: "approved" }, current.etag);

    const [, patch] = drafts.patch.mock.calls[0] ?? [];
    expect(workflowExpressionFixtures(patch?.layout).approved).toBeDefined();
    expect(workflowExpressionFixtureSources(patch?.layout).approved).toBeUndefined();
  });

  it("atomically promotes the exact authorized output with provenance", async () => {
    const drafts = writer();
    const service = new StudioRunOutputFixtureService({
      outputs: output(),
      drafts
    });

    await service.promote(DRAFT_ID, {
      fixture_name: "approved-review",
      run_id: "run-fixture-1",
      node_id: "review",
      graph_hash: DIGEST,
      outcome_hash: DIGEST
    }, draft().etag);

    expect(drafts.patch).toHaveBeenCalledOnce();
    const [draftId, patch, etag] = drafts.patch.mock.calls[0] ?? [];
    expect(draftId).toBe(DRAFT_ID);
    expect(etag).toBe(draft().etag);
    expect(workflowExpressionFixtures(patch?.layout)).toEqual({
      "approved-review": {
        invocation: {},
        config: {},
        steps: { review: { summary: "approved" } },
        workspace: {}
      }
    });
    expect(workflowExpressionFixtureSources(patch?.layout)).toEqual({
      "approved-review": {
        kind: "run_node_output",
        run_id: "run-fixture-1",
        workflow_id: "code-review",
        node_id: "review",
        graph_hash: DIGEST,
        outcome_hash: DIGEST,
        workflow_revision: DIGEST,
        definition_bundle_hash: DIGEST,
        captured_at: "2026-07-11T10:00:03.000Z",
        redaction_changed: true,
        definition_source: {
          kind: "draft",
          draft_id: DRAFT_ID,
          etag: `"source"`
        }
      }
    });
  });

  it("migrates legacy provenance while promoting historical output into an evolved draft", async () => {
    const current = draftWithLegacyFixtureSource();
    const drafts = writer(current);
    const service = new StudioRunOutputFixtureService({
      outputs: output(),
      drafts
    });

    await service.promote(DRAFT_ID, {
      fixture_name: "legacy-preview",
      run_id: "run-fixture-1",
      node_id: "review",
      graph_hash: DIGEST,
      outcome_hash: DIGEST
    }, current.etag);

    expect(drafts.patch).toHaveBeenCalledOnce();
    const [, patch, etag] = drafts.patch.mock.calls[0] ?? [];
    expect(etag).toBe(current.etag);
    expect(workflowExpressionFixtures(patch?.layout)).toEqual({
      "legacy-preview": {
        invocation: {},
        config: {},
        steps: { review: { summary: "approved" } },
        workspace: {}
      }
    });
    expect(workflowExpressionFixtureSources(patch?.layout)).toEqual({
      "legacy-preview": {
        kind: "run_node_output",
        run_id: "run-fixture-1",
        workflow_id: "code-review",
        node_id: "review",
        graph_hash: DIGEST,
        outcome_hash: DIGEST,
        workflow_revision: DIGEST,
        definition_bundle_hash: DIGEST,
        captured_at: "2026-07-11T10:00:03.000Z",
        redaction_changed: true,
        definition_source: {
          kind: "draft",
          draft_id: DRAFT_ID,
          etag: `"source"`
        }
      }
    });
  });

  it("rejects stale output identities before mutation", async () => {
    const drafts = writer();
    const service = new StudioRunOutputFixtureService({
      outputs: output(),
      drafts
    });

    await expect(service.promote(DRAFT_ID, {
      fixture_name: "approved-review",
      run_id: "run-fixture-1",
      node_id: "review",
      graph_hash: OTHER_DIGEST,
      outcome_hash: DIGEST
    }, draft().etag)).rejects.toMatchObject({
      code: "studio_draft_authoring_fixture_conflict"
    });
    expect(drafts.patch).not.toHaveBeenCalled();
  });

  it("rejects missing and stale draft preconditions before reading run output", async () => {
    const drafts = writer();
    const outputs = output();
    const service = new StudioRunOutputFixtureService({ outputs, drafts });
    const request = {
      fixture_name: "approved-review",
      run_id: "run-fixture-1",
      node_id: "review",
      graph_hash: DIGEST,
      outcome_hash: DIGEST
    } as const;

    await expect(
      service.promote(DRAFT_ID, request, undefined)
    ).rejects.toMatchObject({
      code: "studio_draft_authoring_precondition_required"
    });
    await expect(
      service.promote(DRAFT_ID, request, '"stale"')
    ).rejects.toMatchObject({
      code: "studio_draft_authoring_precondition_failed"
    });
    expect(outputs.getWithRecord).not.toHaveBeenCalled();
    expect(drafts.patch).not.toHaveBeenCalled();
  });

  it("rejects output from another workflow", async () => {
    const drafts = writer();
    const otherWorkflowRecord = RunRecordSchema.parse({
      ...record(),
      workflow_id: "another-workflow"
    });
    const service = new StudioRunOutputFixtureService({
      outputs: output({ summary: "approved" }, otherWorkflowRecord),
      drafts
    });

    await expect(
      service.promote(
        DRAFT_ID,
        {
          fixture_name: "approved-review",
          run_id: "run-fixture-1",
          node_id: "review",
          graph_hash: DIGEST,
          outcome_hash: DIGEST
        },
        draft().etag
      )
    ).rejects.toMatchObject({
      code: "studio_draft_authoring_fixture_conflict"
    });
    expect(drafts.patch).not.toHaveBeenCalled();
  });

  it("refuses snapshots that exceed the expression fixture budget", async () => {
    const drafts = writer();
    const service = new StudioRunOutputFixtureService({
      outputs: output({ report: "x".repeat(140 * 1_024) }),
      drafts
    });

    await expect(service.promote(DRAFT_ID, {
      fixture_name: "oversized",
      run_id: "run-fixture-1",
      node_id: "review",
      graph_hash: DIGEST,
      outcome_hash: DIGEST
    }, draft().etag)).rejects.toMatchObject({
      code: "studio_draft_authoring_fixture_too_large"
    });
    expect(drafts.patch).not.toHaveBeenCalled();
  });
});
