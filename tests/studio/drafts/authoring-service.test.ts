import { describe, expect, it, vi } from "vitest";
import type { StudioApplyService } from "../../../src/studio/application/apply/service.js";
import { STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE } from "../../../src/studio/application/apply/scope.js";
import { StudioDraftAuthoringService } from "../../../src/studio/application/drafts/authoring-service.js";
import { StudioDraftAuthoringError } from "../../../src/studio/application/drafts/authoring-errors.js";
import { StudioDraftPersistenceError } from "../../../src/studio/application/drafts/persistence.js";
import { studioDraftEtag } from "../../../src/studio/application/drafts/versioning.js";
import { StudioDraftValidationResultSchema } from "../../../src/studio/contracts/validation.js";
import type { StudioChangeSet } from "../../../src/studio/contracts/drafts.js";
import type { StudioResourceRef } from "../../../src/studio/contracts/paths.js";
import {
  AUTHORING_DRAFT_ID,
  MemoryAuthoringDrafts,
  PRESENTATION_FINGERPRINT,
  RESOURCE_REVISION,
  TECHNICAL_FINGERPRINT,
  memoryAuthoringSource
} from "./authoring-test-support.js";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const OPERATION_ID = "ec28368e-675d-45b8-b516-82f982582d66";
const PLAN_TOKEN = "p".repeat(32);

function validationResult(
  draft: StudioChangeSet,
  compile: boolean
) {
  const revision = RESOURCE_REVISION;
  const resource = draft.primary_resource;
  return StudioDraftValidationResultSchema.parse({
    draft_id: draft.draft_id,
    record_revision: draft.record_revision,
    content_revision: draft.content_revision,
    layout_revision: draft.layout_revision,
    draft_hash: draft.draft_hash,
    status: "valid",
    compiled: compile,
    resources: [
      {
        resource,
        status: "valid",
        revision,
        diagnostics: [],
        ...(compile && resource.kind === "workflow"
          ? {
              compiled_workflow: {
                workflow_id: resource.id,
                workflow_revision: revision,
                state_schema_version: "1",
                nodes: [],
                edges: []
              }
            }
          : {})
      }
    ],
    diagnostics: [],
    validated_at: NOW.toISOString()
  });
}

function fixture(
  sourceFiles: Readonly<Record<string, string | { content: string; mode: number }>> = {},
  now: () => Date = () => NOW,
  modelProfileIds: readonly string[] = ["fast"]
) {
  const drafts = new MemoryAuthoringDrafts();
  const validate = vi.fn(
    async (draft: StudioChangeSet, options: { readonly compile?: boolean } = {}) =>
      validationResult(draft, options.compile ?? false)
  );
  const plan = vi.fn(async (draftId: string) => ({
    status: "ready" as const,
    draft_id: draftId,
    record_revision: drafts.draft?.record_revision ?? 1,
    content_revision: drafts.draft?.content_revision ?? 1,
    draft_hash: drafts.draft?.draft_hash ?? TECHNICAL_FINGERPRINT,
    diff: [],
    conflicts: [],
    resources: drafts.draft?.resources ?? [
      { kind: "workflow" as const, id: "new-flow" }
    ],
    plan_token: PLAN_TOKEN,
    expires_at: "2026-07-10T12:02:00.000Z"
  }));
  const apply = vi.fn(
    async (
      draftId: string,
      _input: {
        readonly planToken: string;
        readonly idempotencyKey: string;
        readonly ifMatch: string;
      }
    ) => ({
      status: "committed" as const,
      operation_id: OPERATION_ID,
      draft_id: draftId,
      record_revision: drafts.draft?.record_revision ?? 1,
      draft_hash: drafts.draft?.draft_hash ?? TECHNICAL_FINGERPRINT,
      resource_revisions: {
        "workflow:new-flow": RESOURCE_REVISION
      },
      files: [],
      diff: [],
      committed_at: NOW.toISOString(),
      idempotent_replay: false
    })
  );
  const applyService: Pick<StudioApplyService, "plan" | "apply"> = {
    plan,
    apply
  };
  const service = new StudioDraftAuthoringService({
    drafts,
    source: memoryAuthoringSource(sourceFiles),
    revisions: { current: async () => RESOURCE_REVISION },
    catalogs: {
      technical: () => TECHNICAL_FINGERPRINT,
      presentation: () => PRESENTATION_FINGERPRINT
    },
    modelProfiles: { ids: async () => modelProfileIds },
    validation: { validate },
    apply: applyService,
    now,
    randomDraftId: () => AUTHORING_DRAFT_ID
  });
  return { service, drafts, validate, plan, apply };
}

describe("StudioDraftAuthoringService", () => {
  it("exposes immutable versioned workflow templates and rejects stale selections", async () => {
    const { service } = fixture();

    expect(service.templates()).toEqual({
      templates: expect.arrayContaining([
        expect.objectContaining({ id: "blank-workflow", version: "1" }),
        expect.objectContaining({ id: "read-only-pipeline", version: "1" }),
        expect.objectContaining({
          id: "agent-workflow",
          version: "1",
          parameters: [expect.objectContaining({ id: "agent" })]
        }),
        expect.objectContaining({ id: "parallel-review", version: "1" }),
        expect.objectContaining({ id: "gated-repair-loop", version: "1" }),
        expect.objectContaining({
          id: "human-approval-side-effect",
          version: "1",
          classification: "showcase"
        }),
        expect.objectContaining({ id: "context-report", version: "1" })
      ])
    });
    await expect(
      service.create({
        resource: { kind: "workflow", id: "stale-template" },
        source: {
          mode: "template",
          template_id: "read-only-pipeline",
          template_version: "0"
        }
      })
    ).rejects.toMatchObject({ code: "studio_draft_authoring_resource_invalid" });
    await expect(
      service.create({
        resource: { kind: "workflow", id: "missing-agent" },
        source: {
          mode: "template",
          template_id: "agent-workflow",
          template_version: "1",
          parameters: {
            agent: { id: "not-installed", output_schema: "output.schema.json" }
          }
        }
      })
    ).rejects.toMatchObject({ code: "studio_draft_authoring_resource_invalid" });
  });

  it("creates a blank workflow from bounded server-owned files", async () => {
    const { service, drafts } = fixture();

    const item = await service.create({
      resource: { kind: "workflow", id: "new-flow" },
      source: { mode: "blank" }
    });

    expect(item).toMatchObject({
      draft_id: AUTHORING_DRAFT_ID,
      primary_resource: { kind: "workflow", id: "new-flow" },
      record_revision: 1,
      content_revision: 1,
      layout_revision: 0,
      status: "dirty"
    });
    expect(item.files.map((file) => file.file.path)).toEqual([
      "workflows/new-flow/input.schema.json",
      "workflows/new-flow/output.schema.json",
      "workflows/new-flow/workflow.yaml"
    ]);
    expect(item.files.every((file) => file.state === "present")).toBe(true);
    const persisted = drafts.draft;
    expect(persisted).toBeDefined();
    if (persisted === undefined) {
      throw new Error("Expected the draft fixture to persist the created draft");
    }
    expect(item.etag).toBe(studioDraftEtag(persisted));
    expect(drafts.draft?.allowed_files).toEqual(
      drafts.draft?.base_files.map((file) => file.file)
    );
    expect(drafts.draft?.base_files.every((file) => file.sha256 === null)).toBe(
      true
    );
    expect(drafts.draft?.changes).toHaveLength(3);
    expect(drafts.blobs.size).toBe(2);

    await expect(service.get(item.draft_id)).resolves.toEqual(item);
    await expect(service.list()).resolves.toMatchObject({
      items: [{ draft_id: item.draft_id, etag: item.etag }]
    });
  });

  it("keeps configuration drafts outside every generic authoring command", async () => {
    const { service, drafts, validate, plan } = fixture();
    const created = await service.create({
      resource: { kind: "workflow", id: "private-config" },
      source: { mode: "blank" }
    });
    if (drafts.draft === undefined) throw new Error("Expected draft");
    drafts.draft = {
      ...drafts.draft,
      primary_resource: { kind: "config", id: "private-config" },
      resources: [{ kind: "config", id: "private-config" }],
      resource_revisions: {
        "config:private-config": RESOURCE_REVISION
      }
    };

    await expect(service.list()).resolves.toMatchObject({ items: [] });
    const commands = [
      () => service.get(created.draft_id),
      () => service.patch(created.draft_id, { layout: {} }, created.etag),
      () => service.editSource(created.draft_id, {
        file: {
          root: "project" as const,
          path: "workflows/private-config/workflow.yaml"
        },
        operations: [{ op: "set" as const, path: ["mode"], value: "read_only" }]
      }, created.etag),
      () => service.sourceView(created.draft_id, {
        root: "project" as const,
        path: "workflows/private-config/workflow.yaml"
      }),
      () => service.validate(created.draft_id, created.etag),
      () => service.compile(created.draft_id, created.etag),
      () => service.planApply(created.draft_id),
      () => service.delete(created.draft_id, created.etag)
    ];
    for (const command of commands) {
      await expect(command()).rejects.toMatchObject({
        code: "studio_draft_authoring_not_found"
      });
    }
    expect(validate).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(drafts.draft?.primary_resource.kind).toBe("config");
  });

  it("creates a blank agent without accepting an existing target collision", async () => {
    const colliding = fixture({
      "project:agents/new-agent/agent.yaml": "id: already-there\n"
    });
    await expect(
      colliding.service.create({
        resource: { kind: "agent", id: "new-agent" },
        source: { mode: "blank", model_profile: "fast" }
      })
    ).rejects.toMatchObject({
      code: "studio_draft_authoring_resource_invalid"
    });

    const clean = fixture();
    const item = await clean.service.create({
      resource: { kind: "agent", id: "new-agent" },
      source: { mode: "blank", model_profile: "fast" }
    });
    expect(item.files.map((file) => file.file.path)).toEqual([
      "agents/new-agent/agent.yaml",
      "agents/new-agent/instructions.md",
      "agents/new-agent/output.schema.json"
    ]);
    expect(
      item.files.find((file) => file.file.path.endsWith("agent.yaml"))?.content
    ).toContain("model_profile: fast");

    const staleSelection = fixture({}, () => NOW, ["deep"]);
    await expect(
      staleSelection.service.create({
        resource: { kind: "agent", id: "stale-profile-agent" },
        source: { mode: "blank", model_profile: "fast" }
      })
    ).rejects.toMatchObject({
      code: "studio_draft_authoring_model_profile_unavailable"
    });
    expect(staleSelection.drafts.draft).toBeUndefined();
  });

  it("applies a generic lossless YAML command with If-Match in one draft CAS", async () => {
    const { service, drafts } = fixture();
    const created = await service.create({
      resource: { kind: "workflow", id: "new-flow" },
      source: { mode: "blank" }
    });
    const file = { root: "project" as const, path: "workflows/new-flow/workflow.yaml" };
    const updated = await service.editSource(
      created.draft_id,
      {
        file,
        operations: [
          {
            op: "sequence_insert",
            path: ["capabilities"],
            value: "runtime"
          },
          {
            op: "sequence_insert",
            path: ["nodes"],
            value: {
              id: "preflight",
              type: "built_in",
              uses: "runtime.preflight"
            }
          }
        ]
      },
      created.etag
    );

    expect(updated).toMatchObject({
      record_revision: 2,
      content_revision: 2,
      status: "dirty"
    });
    const workflow = updated.files.find(
      (item) => item.file.path === file.path
    );
    expect(workflow?.content).toContain("capabilities: [ runtime ]\n");
    expect(workflow?.content).toContain(
      "nodes: [ { id: preflight, type: built_in, uses: runtime.preflight } ]\n"
    );
    expect(drafts.draft?.record_revision).toBe(2);

    await expect(
      service.editSource(
        created.draft_id,
        {
          file,
          operations: [{ op: "delete", path: ["missing"] }]
        },
        updated.etag
      )
    ).rejects.toMatchObject({ code: "studio_draft_authoring_source_invalid" });
    await expect(service.get(created.draft_id)).resolves.toEqual(updated);
    await expect(
      service.editSource(
        created.draft_id,
        {
          file,
          operations: [{ op: "set", path: ["mode"], value: "read_only" }]
        },
        created.etag
      )
    ).rejects.toMatchObject({
      code: "studio_draft_authoring_precondition_failed"
    });
  });

  it("opens existing workflow bytes and pins server-discovered dependencies", async () => {
    const workflow = [
      "id: review",
      "type: workflow",
      "mode: read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "config:",
      "  file: workflows/review.json",
      "  schema: config.schema.json",
      "capabilities: [agents]",
      "nodes:",
      "  - id: review",
      "    type: agent",
      "    agent: reviewer",
      "    output_schema: output.schema.json",
      ""
    ].join("\n");
    const agent = [
      "id: reviewer",
      "description: Reviewer.",
      "model_profile: fast",
      "mode: read_only",
      "instructions_file: instructions.md",
      "output_schema: output.schema.json",
      ""
    ].join("\n");
    const json = "{\n  \"type\": \"object\"\n}\n";
    const { service, drafts } = fixture({
      "project:workflows/review/workflow.yaml": workflow,
      "project:workflows/review/input.schema.json": json,
      "project:workflows/review/output.schema.json": json,
      "project:workflows/review/config.schema.json": json,
      "project:agents/reviewer/agent.yaml": agent,
      "project:agents/reviewer/instructions.md": "Review carefully.\n",
      "project:agents/reviewer/output.schema.json": json,
      "config:workflows/review.json": "{}\n"
    });

    const item = await service.create({
      resource: { kind: "workflow", id: "review" },
      source: { mode: "existing" }
    });

    expect(
      item.files.find((file) => file.file.path.endsWith("workflow.yaml"))
        ?.content
    ).toBe(workflow);
    expect(drafts.draft?.changes).toEqual([]);
    expect(drafts.draft?.resource_revisions).toEqual({
      "workflow:review": RESOURCE_REVISION
    });
    expect(drafts.draft?.dependencies.map((entry) => `${entry.file.root}:${entry.file.path}`)).toEqual([
      "config:workflows/review.json",
      "project:agents/reviewer/agent.yaml",
      "project:agents/reviewer/instructions.md",
      "project:agents/reviewer/output.schema.json"
    ]);
    expect(
      drafts.draft?.allowed_files.every(
        (file) =>
          file.root === "project" &&
          file.path.startsWith("workflows/review/")
      )
    ).toBe(true);
  });

  it("applies content and layout atomically while preserving the base mode", async () => {
    const original = [
      "id: review",
      "type: workflow",
      "mode: read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "capabilities: []",
      "nodes: []",
      ""
    ].join("\n");
    const json = "{\"type\":\"object\"}\n";
    const { service, drafts } = fixture({
      "project:workflows/review/workflow.yaml": {
        content: original,
        mode: 0o755
      },
      "project:workflows/review/input.schema.json": json,
      "project:workflows/review/output.schema.json": json
    });
    const created = await service.create({
      resource: { kind: "workflow", id: "review" },
      source: { mode: "existing" }
    });
    const changed = `${original}# retained local comment\n`;

    const updated = await service.patch(
      created.draft_id,
      {
        edits: [
          {
            action: "write",
            file: {
              root: "project",
              path: "workflows/review/workflow.yaml"
            },
            content: changed
          }
        ],
        layout: { nodes: { review: { x: 10, y: 20 } } }
      },
      created.etag
    );

    expect(updated).toMatchObject({
      record_revision: 2,
      content_revision: 2,
      layout_revision: 1,
      status: "dirty"
    });
    expect(
      updated.files.find((file) => file.file.path.endsWith("workflow.yaml"))
        ?.content
    ).toBe(changed);
    expect(drafts.draft?.changes).toEqual([
      expect.objectContaining({ action: "write", mode: 0o755 })
    ]);
  });

  it("rejects a closure refresh that would discard a dirty file without persisting anything", async () => {
    const original = [
      "id: review",
      "type: workflow",
      "mode: read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "capabilities: []",
      "nodes: []",
      ""
    ].join("\n");
    const nextDefinition = original.replace(
      "input_schema: input.schema.json",
      "input_schema: request.schema.json"
    );
    const { service, drafts } = fixture({
      "project:workflows/review/workflow.yaml": original,
      "project:workflows/review/input.schema.json": "{\"type\":\"object\"}\n",
      "project:workflows/review/output.schema.json": "{\"type\":\"object\"}\n",
      "project:workflows/review/request.schema.json": "{\"type\":\"string\"}\n"
    });
    const created = await service.create({
      resource: { kind: "workflow", id: "review" },
      source: { mode: "existing" }
    });
    const inputFile = created.files.find((file) =>
      file.file.path.endsWith("input.schema.json")
    );
    if (inputFile === undefined) throw new Error("Expected the input schema");
    const dirty = await service.patch(
      created.draft_id,
      {
        edits: [{
          action: "write",
          file: inputFile.file,
          content: "{\"type\":\"number\"}\n"
        }]
      },
      created.etag
    );
    const beforeDraft = structuredClone(drafts.draft);
    const beforeBlobs = [...drafts.blobs.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    );
    const requestFile = {
      root: "project" as const,
      path: "workflows/review/request.schema.json"
    };
    const definitionFile = {
      root: "project" as const,
      path: "workflows/review/workflow.yaml"
    };

    await expect(
      service.patch(
        created.draft_id,
        {
          edits: [
            {
              action: "write",
              file: requestFile,
              content: "{\"type\":\"boolean\"}\n"
            },
            {
              action: "write",
              file: definitionFile,
              content: nextDefinition
            }
          ]
        },
        dirty.etag
      )
    ).rejects.toMatchObject({
      code: "studio_draft_authoring_dirty_file_conflict",
      details: {
        file: inputFile.file,
        files: [inputFile.file],
        fieldPath: "$.edits[1].content",
        actualEntries: 1
      }
    });

    expect(drafts.draft).toEqual(beforeDraft);
    expect(
      [...drafts.blobs.entries()].sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ).toEqual(beforeBlobs);
    expect(drafts.draft?.changes).toHaveLength(1);
    await expect(service.get(created.draft_id)).resolves.toEqual(dirty);
  });

  it("rejects stale, duplicate, unauthorized, no-op, and oversized patches", async () => {
    const { service } = fixture();
    const created = await service.create({
      resource: { kind: "workflow", id: "new-flow" },
      source: { mode: "blank" }
    });
    const workflow = created.files.find((file) =>
      file.file.path.endsWith("workflow.yaml")
    )!;

    await expect(
      service.patch(
        created.draft_id,
        { layout: { selected: "node" } },
        '"stale"'
      )
    ).rejects.toMatchObject({
      code: "studio_draft_authoring_precondition_failed"
    });
    await expect(
      service.patch(
        created.draft_id,
        {
          edits: [
            {
              action: "write",
              file: { root: "project", path: "agents/escape/agent.yaml" },
              content: "id: escape\n"
            }
          ]
        },
        created.etag
      )
    ).rejects.toMatchObject({
      code: "studio_draft_authoring_file_not_editable"
    });
    await expect(
      service.patch(
        created.draft_id,
        {
          edits: [
            { action: "delete", file: workflow.file },
            { action: "delete", file: workflow.file }
          ]
        },
        created.etag
      )
    ).rejects.toMatchObject({
      code: "studio_draft_authoring_duplicate_edit"
    });
    await expect(
      service.patch(
        created.draft_id,
        {
          edits: [
            {
              action: "write",
              file: workflow.file,
              content: workflow.content!
            }
          ]
        },
        created.etag
      )
    ).rejects.toMatchObject({ code: "studio_draft_authoring_noop" });
    await expect(
      service.patch(
        created.draft_id,
        {
          edits: [
            {
              action: "write",
              file: workflow.file,
              content: "é".repeat(1024 * 1024 + 1)
            }
          ]
        },
        created.etag
      )
    ).rejects.toBeInstanceOf(StudioDraftAuthoringError);
  });

  it("persists validation status, compiles, and delegates Plan/Apply authority", async () => {
    const { service, validate, plan, apply } = fixture();
    const created = await service.create({
      resource: { kind: "workflow", id: "new-flow" },
      source: { mode: "blank" }
    });

    const validated = await service.validate(created.draft_id, created.etag);
    expect(validated.draft).toMatchObject({
      status: "valid",
      record_revision: 2,
      content_revision: 1
    });
    expect(validated.validation).toMatchObject({
      record_revision: 2,
      content_revision: 1,
      draft_hash: validated.draft.draft_hash
    });
    expect(validate).toHaveBeenLastCalledWith(
      expect.objectContaining({ record_revision: 1 }),
      { compile: false }
    );

    const compiled = await service.compile(
      created.draft_id,
      validated.draft.etag
    );
    expect(compiled.validation).toMatchObject({
      status: "valid",
      compiled: true
    });
    expect(compiled.draft.etag).toBe(validated.draft.etag);

    await expect(service.planApply(created.draft_id)).resolves.toMatchObject({
      status: "ready",
      plan_token: PLAN_TOKEN
    });
    expect(plan).toHaveBeenCalledWith(
      created.draft_id,
      STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE
    );

    await expect(
      service.apply(created.draft_id, {
        planToken: PLAN_TOKEN,
        idempotencyKey: "apply-new-flow",
        ifMatch: compiled.draft.etag
      })
    ).resolves.toMatchObject({ status: "committed" });
    expect(apply).toHaveBeenCalledWith(
      created.draft_id,
      {
        planToken: PLAN_TOKEN,
        idempotencyKey: "apply-new-flow",
        ifMatch: compiled.draft.etag
      },
      STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE
    );
  });

  it("lets the canonical apply authority replay after the draft is gone", async () => {
    const { service, drafts, apply } = fixture();
    const created = await service.create({
      resource: { kind: "workflow", id: "replayed-flow" },
      source: { mode: "blank" }
    });
    drafts.draft = undefined;

    await expect(service.apply(created.draft_id, {
      planToken: PLAN_TOKEN,
      idempotencyKey: "replay-after-draft-delete",
      ifMatch: created.etag
    })).resolves.toMatchObject({ status: "committed" });
    expect(apply).toHaveBeenCalledWith(
      created.draft_id,
      expect.objectContaining({ ifMatch: created.etag }),
      STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE
    );
  });

  it("strictly advances timestamps when the clock repeats or regresses", async () => {
    const later = new Date("2026-07-10T12:00:01.000Z");
    const earlier = new Date("2026-07-10T12:00:00.000Z");
    const clock = vi
      .fn<() => Date>()
      .mockReturnValueOnce(later)
      .mockReturnValue(earlier);
    const { service } = fixture({}, clock);
    const created = await service.create({
      resource: { kind: "workflow", id: "monotonic-clock" },
      source: { mode: "blank" }
    });

    const updated = await service.patch(
      created.draft_id,
      { layout: { zoom: 1 } },
      created.etag
    );

    expect(Date.parse(updated.updated_at)).toBe(
      Date.parse(created.updated_at) + 1
    );
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("translates a persistence CAS race into the authoring precondition error", async () => {
    const { service, drafts } = fixture();
    const created = await service.create({
      resource: { kind: "workflow", id: "concurrent-flow" },
      source: { mode: "blank" }
    });
    vi.spyOn(drafts, "update").mockRejectedValueOnce(
      new StudioDraftPersistenceError(
        "studio_draft_revision_conflict",
        "simulated concurrent update"
      )
    );

    await expect(
      service.patch(
        created.draft_id,
        { layout: { selected: "node" } },
        created.etag
      )
    ).rejects.toMatchObject({
      code: "studio_draft_authoring_precondition_failed",
      cause: { code: "studio_draft_revision_conflict" }
    });
  });

  it("preserves the canonical create conflict across the authoring surface", async () => {
    const { service } = fixture();
    const request = {
      resource: { kind: "workflow" as const, id: "duplicate-draft-id" },
      source: { mode: "blank" as const }
    };
    await service.create(request);

    await expect(service.create(request)).rejects.toMatchObject({
      code: "studio_draft_already_exists"
    });
  });

  it("requires optimistic concurrency for delete and removes the draft", async () => {
    const { service } = fixture();
    const created = await service.create({
      resource: { kind: "agent", id: "new-agent" },
      source: { mode: "blank", model_profile: "fast" }
    });

    await expect(service.delete(created.draft_id, undefined)).rejects.toMatchObject({
      code: "studio_draft_authoring_precondition_required"
    });
    await service.delete(created.draft_id, created.etag);
    await expect(service.get(created.draft_id)).rejects.toMatchObject({
      code: "studio_draft_authoring_not_found"
    });
  });
});
