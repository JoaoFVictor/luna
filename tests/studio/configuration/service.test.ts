import { describe, expect, it, vi } from "vitest";
import type { StudioApplyService } from "../../../src/studio/application/apply/service.js";
import { studioConfigurationApplyScope } from "../../../src/studio/application/apply/scope.js";
import { StudioConfigurationService } from "../../../src/studio/application/configuration/service.js";
import { projectStudioDraftItem } from "../../../src/studio/application/drafts/authoring-projection.js";
import { StudioDraftPersistenceError } from "../../../src/studio/application/drafts/persistence.js";
import { studioDraftEtag } from "../../../src/studio/application/drafts/versioning.js";
import type { StudioChangeSet } from "../../../src/studio/contracts/drafts.js";
import { StudioDraftValidationResultSchema } from "../../../src/studio/contracts/validation.js";
import {
  AUTHORING_DRAFT_ID,
  MemoryAuthoringDrafts,
  PRESENTATION_FINGERPRINT,
  RESOURCE_REVISION,
  TECHNICAL_FINGERPRINT,
  memoryAuthoringSource
} from "../drafts/authoring-test-support.js";

const NOW = new Date("2026-07-11T01:00:00.000Z");
const PLAN_TOKEN = "c".repeat(32);
const OPERATION_ID = "3c388af7-d95b-4cd3-8250-daa86a6a3996";
const PRIVATE_CANARY = "CONFIG_PRIVATE_CANARY_6f7b";
const APPLY_INTERNAL_CANARY = "APPLY_INTERNAL_CANARY_e642";

const WORKFLOW = [
  "id: review",
  "type: workflow",
  "mode: read_only",
  "input_schema: input.schema.json",
  "output_schema: output.schema.json",
  "config:",
  "  file: review.yaml",
  "  schema: config.schema.json",
  "capabilities: []",
  "nodes:",
  "  - id: inspect_config",
  "    type: built_in",
  "    uses: runtime.preflight",
  "    input:",
  "      enabled:",
  '        expression: "$.config.settings.enabled"',
  ""
].join("\n");

const CONFIG_SCHEMA = JSON.stringify(
  {
    type: "object",
    additionalProperties: false,
    required: ["settings"],
    properties: {
      settings: {
        type: "object",
        additionalProperties: false,
        required: ["enabled", "label", "tags", "hidden", "token"],
        properties: {
          enabled: {
            type: "boolean",
            title: "Enabled",
            "x-luna-studio": { exposure: "editable" }
          },
          label: {
            type: "string",
            "x-luna-studio": { exposure: "read_only" }
          },
          tags: {
            type: "array",
            items: { type: "string" },
            maxItems: 3,
            "x-luna-studio": { exposure: "editable" }
          },
          hidden: { type: "string" },
          token: {
            type: "string",
            writeOnly: true,
            "x-luna-studio": { exposure: "editable" }
          }
        }
      }
    }
  },
  null,
  2
);

const CONFIG = [
  "settings:",
  "  # This comment must survive structured edits.",
  "  enabled: false",
  "  label: stable",
  "  tags:",
  "    - one",
  `  hidden: ${PRIVATE_CANARY}`,
  `  token: ${PRIVATE_CANARY}`,
  ""
].join("\n");

function sourceFiles() {
  const json = '{"type":"object"}\n';
  return {
    "project:workflows/review/workflow.yaml": WORKFLOW,
    "project:workflows/review/input.schema.json": json,
    "project:workflows/review/output.schema.json": json,
    "project:workflows/review/config.schema.json": `${CONFIG_SCHEMA}\n`,
    "config:review.yaml": CONFIG
  };
}

function validResult(draft: StudioChangeSet) {
  return StudioDraftValidationResultSchema.parse({
    draft_id: draft.draft_id,
    record_revision: draft.record_revision,
    content_revision: draft.content_revision,
    layout_revision: draft.layout_revision,
    draft_hash: draft.draft_hash,
    status: "valid",
    compiled: false,
    resources: [
      {
        resource: draft.primary_resource,
        status: "valid",
        revision: RESOURCE_REVISION,
        diagnostics: []
      }
    ],
    diagnostics: [],
    validated_at: NOW.toISOString()
  });
}

function fixture(now: () => Date = () => NOW) {
  const drafts = new MemoryAuthoringDrafts();
  const validate = vi.fn(async (draft: StudioChangeSet) => validResult(draft));
  const plan = vi.fn(async (draftId: string) => ({
    status: "ready" as const,
    draft_id: draftId,
    record_revision: drafts.draft?.record_revision ?? 1,
    content_revision: drafts.draft?.content_revision ?? 1,
    draft_hash: drafts.draft?.draft_hash ?? TECHNICAL_FINGERPRINT,
    diff: [
      {
        file: { root: "config" as const, path: "review.yaml" },
        kind: "modified" as const,
        before_sha256: TECHNICAL_FINGERPRINT,
        after_sha256: PRESENTATION_FINGERPRINT,
        before_mode: 0o644,
        after_mode: 0o644,
        textual_diff: APPLY_INTERNAL_CANARY,
        textual_diff_truncated: false,
        redacted: true as const
      }
    ],
    conflicts: [],
    resources: [{ kind: "config" as const, id: "review" }],
    plan_token: PLAN_TOKEN,
    expires_at: "2026-07-11T01:02:00.000Z"
  }));
  const apply = vi.fn(async (draftId: string) => ({
    status: "committed" as const,
    operation_id: OPERATION_ID,
    draft_id: draftId,
    record_revision: drafts.draft?.record_revision ?? 1,
    draft_hash: drafts.draft?.draft_hash ?? TECHNICAL_FINGERPRINT,
    resource_revisions: { "config:review": RESOURCE_REVISION },
    files: [
      {
        file: { root: "config" as const, path: "review.yaml" },
        sha256: PRESENTATION_FINGERPRINT
      }
    ],
    diff: [
      {
        file: { root: "config" as const, path: "review.yaml" },
        kind: "modified" as const,
        before_sha256: TECHNICAL_FINGERPRINT,
        after_sha256: PRESENTATION_FINGERPRINT,
        before_mode: 0o644,
        after_mode: 0o644,
        textual_diff: APPLY_INTERNAL_CANARY,
        textual_diff_truncated: false,
        redacted: true as const
      }
    ],
    committed_at: NOW.toISOString(),
    idempotent_replay: false
  }));
  const service = new StudioConfigurationService({
    drafts,
    source: memoryAuthoringSource(sourceFiles()),
    revisions: { current: async () => RESOURCE_REVISION },
    catalogs: {
      technical: () => TECHNICAL_FINGERPRINT,
      presentation: () => PRESENTATION_FINGERPRINT
    },
    validation: { validate },
    apply: { plan, apply } as Pick<StudioApplyService, "plan" | "apply">,
    now,
    randomDraftId: () => AUTHORING_DRAFT_ID
  });
  return { service, drafts, validate, plan, apply };
}

describe("StudioConfigurationService", () => {
  it("returns only classified workflow values and explicit $.config usage", async () => {
    const { service } = fixture();
    const view = await service.get("review");

    expect(view).toMatchObject({
      workflow_id: "review",
      status: "ready",
      declared: true,
      config_present: true,
      schema_present: true,
      raw_yaml_enabled: false,
      file_reference: "config:review.yaml",
      schema_reference: "project:workflows/review/config.schema.json"
    });
    expect(view.fields).toEqual([
      expect.objectContaining({
        path: ["settings", "enabled"],
        exposure: "editable",
        value: false
      }),
      expect.objectContaining({
        path: ["settings", "label"],
        exposure: "read_only",
        value: "stable"
      }),
      expect.objectContaining({
        path: ["settings", "tags"],
        exposure: "editable",
        value: ["one"]
      })
    ]);
    expect(JSON.stringify(view)).not.toContain(PRIVATE_CANARY);
    expect(view.references).toEqual([
      { expression: "$.config.settings.enabled" }
    ]);
    expect(view.diagnostics).toContainEqual(
      expect.objectContaining({ code: "configuration_write_only_blocked" })
    );
  });

  it("creates a private config-kind draft that generic draft projection cannot expose", async () => {
    const { service, drafts } = fixture();
    const draft = await service.createDraft("review");

    expect(draft).toMatchObject({
      draft_id: AUTHORING_DRAFT_ID,
      record_revision: 1,
      content_revision: 1,
      configuration: { workflow_id: "review", raw_yaml_enabled: false }
    });
    expect(JSON.stringify(draft)).not.toContain(PRIVATE_CANARY);
    expect(drafts.draft).toMatchObject({
      primary_resource: { kind: "config", id: "review" },
      resources: [{ kind: "config", id: "review" }],
      changes: []
    });
    expect(
      drafts.draft?.base_files.map((base) => `${base.file.root}:${base.file.path}`)
    ).toEqual([
      "config:review.yaml",
      "project:workflows/review/config.schema.json",
      "project:workflows/review/input.schema.json",
      "project:workflows/review/output.schema.json",
      "project:workflows/review/workflow.yaml"
    ]);
    if (drafts.draft === undefined) throw new Error("Expected persisted draft");
    await expect(projectStudioDraftItem(drafts, drafts.draft)).rejects.toMatchObject({
      code: "studio_draft_authoring_resource_invalid"
    });
  });

  it("patches only classified editable leaves with ETag CAS and preserves private YAML", async () => {
    const { service, drafts } = fixture();
    const created = await service.createDraft("review");
    const updated = await service.patchDraft(
      "review",
      created.draft_id,
      {
        updates: [
          { path: ["settings", "enabled"], value: true },
          { path: ["settings", "tags"], value: ["one", "two"] }
        ]
      },
      created.etag
    );

    expect(updated).toMatchObject({
      record_revision: 2,
      content_revision: 2,
      status: "dirty"
    });
    expect(updated.updated_at > created.updated_at).toBe(true);
    expect(updated.configuration.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["settings", "enabled"], value: true }),
        expect.objectContaining({
          path: ["settings", "tags"],
          value: ["one", "two"]
        })
      ])
    );
    expect(JSON.stringify(updated)).not.toContain(PRIVATE_CANARY);
    const change = drafts.draft?.changes[0];
    if (change?.action !== "write") throw new Error("Expected private YAML change");
    const privateYaml = drafts.blobs.get(change.content_ref);
    expect(privateYaml).toContain("# This comment must survive structured edits.");
    expect(privateYaml).toContain(PRIVATE_CANARY);

    await expect(
      service.patchDraft(
        "review",
        created.draft_id,
        { updates: [{ path: ["settings", "hidden"], value: "expose" }] },
        updated.etag
      )
    ).rejects.toMatchObject({ code: "studio_configuration_field_not_editable" });
    await expect(
      service.patchDraft(
        "review",
        created.draft_id,
        { updates: [{ path: ["settings", "label"], value: "changed" }] },
        updated.etag
      )
    ).rejects.toMatchObject({ code: "studio_configuration_field_not_editable" });
    await expect(
      service.patchDraft(
        "review",
        created.draft_id,
        { updates: [{ path: ["settings", "enabled"], value: false }] },
        created.etag
      )
    ).rejects.toMatchObject({ code: "studio_configuration_precondition_failed" });
  });

  it("returns classified diffs and strips internal textual diffs from plan and apply", async () => {
    const { service, apply } = fixture();
    const created = await service.createDraft("review");
    const updated = await service.patchDraft(
      "review",
      created.draft_id,
      { updates: [{ path: ["settings", "enabled"], value: true }] },
      created.etag
    );
    const validated = await service.validateDraft(
      "review",
      updated.draft_id,
      updated.etag
    );
    const plan = await service.planApply("review", updated.draft_id);

    expect(validated).toMatchObject({
      draft: { status: "valid" },
      validation: { status: "valid" }
    });
    expect(plan).toMatchObject({
      status: "ready",
      plan_token: PLAN_TOKEN,
      changes: [
        {
          path: ["settings", "enabled"],
          before: false,
          after: true
        }
      ]
    });
    expect(JSON.stringify(plan)).not.toContain(PRIVATE_CANARY);
    expect(JSON.stringify(plan)).not.toContain(APPLY_INTERNAL_CANARY);

    const result = await service.apply("review", updated.draft_id, {
      planToken: PLAN_TOKEN,
      idempotencyKey: "configuration-safe-apply",
      ifMatch: validated.draft.etag
    });
    expect(result).toMatchObject({
      status: "committed",
      operation_id: OPERATION_ID
    });
    expect(result).not.toHaveProperty("diff");
    expect(JSON.stringify(result)).not.toContain(APPLY_INTERNAL_CANARY);
    expect(apply).toHaveBeenCalledWith(
      updated.draft_id,
      {
        planToken: PLAN_TOKEN,
        idempotencyKey: "configuration-safe-apply",
        ifMatch: validated.draft.etag
      },
      studioConfigurationApplyScope("review")
    );
  });

  it("delegates exact configuration replays after the draft is gone", async () => {
    const { service, drafts, apply } = fixture();
    const created = await service.createDraft("review");
    drafts.draft = undefined;

    await expect(service.apply("review", created.draft_id, {
      planToken: PLAN_TOKEN,
      idempotencyKey: "configuration-replay-after-delete",
      ifMatch: created.etag
    })).resolves.toMatchObject({ status: "committed" });
    expect(apply).toHaveBeenCalledWith(
      created.draft_id,
      expect.objectContaining({ ifMatch: created.etag }),
      studioConfigurationApplyScope("review")
    );
  });

  it("rejects an apply plan whose token and safe diff came from different revisions", async () => {
    const { service, plan } = fixture();
    const created = await service.createDraft("review");
    const originalPlan = plan.getMockImplementation();
    if (originalPlan === undefined) throw new Error("Expected plan fixture");
    plan.mockImplementationOnce(async (...args) => {
      await service.patchDraft(
        "review",
        created.draft_id,
        { updates: [{ path: ["settings", "enabled"], value: true }] },
        created.etag
      );
      return await originalPlan(...args);
    });

    await expect(
      service.planApply("review", created.draft_id)
    ).rejects.toMatchObject({
      code: "studio_configuration_precondition_failed"
    });
  });

  it("binds every operation to both the workflow id and config draft identity", async () => {
    const { service, drafts } = fixture();
    const created = await service.createDraft("review");
    await expect(service.getDraft("other", created.draft_id)).rejects.toMatchObject({
      code: "studio_configuration_draft_mismatch"
    });
    if (drafts.draft === undefined) throw new Error("Expected draft");
    drafts.draft = {
      ...drafts.draft,
      changes: [
        {
          action: "write",
          file: {
            root: "project",
            path: "workflows/review/config.schema.json"
          },
          base_sha256: drafts.draft.base_files[1].sha256,
          content_sha256: TECHNICAL_FINGERPRINT,
          content_ref: TECHNICAL_FINGERPRINT
        }
      ]
    };
    await expect(service.getDraft("review", created.draft_id)).rejects.toMatchObject({
      code: "studio_configuration_draft_mismatch"
    });
  });

  it("requires If-Match and rejects invalid or no-op safe values", async () => {
    const { service, drafts } = fixture();
    const created = await service.createDraft("review");
    await expect(
      service.patchDraft(
        "review",
        created.draft_id,
        { updates: [{ path: ["settings", "enabled"], value: true }] },
        undefined
      )
    ).rejects.toMatchObject({ code: "studio_configuration_precondition_required" });
    await expect(
      service.patchDraft(
        "review",
        created.draft_id,
        { updates: [{ path: ["settings", "tags"], value: ["1", "2", "3", "4"] }] },
        created.etag
      )
    ).rejects.toMatchObject({ code: "studio_configuration_value_invalid" });
    await expect(
      service.patchDraft(
        "review",
        created.draft_id,
        { updates: [{ path: ["settings", "enabled"], value: false }] },
        created.etag
      )
    ).rejects.toMatchObject({ code: "studio_configuration_noop" });
    if (drafts.draft === undefined) throw new Error("Expected persisted draft");
    expect(studioDraftEtag(drafts.draft)).toBe(created.etag);
  });

  it("strictly advances timestamps when the configuration clock regresses", async () => {
    const later = new Date("2026-07-11T01:00:01.000Z");
    const earlier = new Date("2026-07-11T01:00:00.000Z");
    const clock = vi
      .fn<() => Date>()
      .mockReturnValueOnce(later)
      .mockReturnValue(earlier);
    const { service } = fixture(clock);
    const created = await service.createDraft("review");
    const updated = await service.patchDraft(
      "review",
      created.draft_id,
      { updates: [{ path: ["settings", "enabled"], value: true }] },
      created.etag
    );

    expect(Date.parse(updated.updated_at)).toBe(
      Date.parse(created.updated_at) + 1
    );
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("translates a persistence CAS race into the configuration precondition error", async () => {
    const { service, drafts } = fixture();
    const created = await service.createDraft("review");
    vi.spyOn(drafts, "update").mockRejectedValueOnce(
      new StudioDraftPersistenceError(
        "studio_draft_revision_conflict",
        "simulated concurrent update"
      )
    );

    await expect(
      service.patchDraft(
        "review",
        created.draft_id,
        { updates: [{ path: ["settings", "enabled"], value: true }] },
        created.etag
      )
    ).rejects.toMatchObject({
      code: "studio_configuration_precondition_failed",
      cause: { code: "studio_draft_revision_conflict" }
    });
  });

  it("preserves the canonical create conflict across the configuration surface", async () => {
    const { service } = fixture();
    await service.createDraft("review");

    await expect(service.createDraft("review")).rejects.toMatchObject({
      code: "studio_draft_already_exists"
    });
  });
});
