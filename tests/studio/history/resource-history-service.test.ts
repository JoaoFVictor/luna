import { describe, expect, it, vi } from "vitest";
import { studioAuthoringContentDigest } from "../../../src/studio/application/drafts/authoring-digests.js";
import { StudioResourceHistoryService } from "../../../src/studio/application/history/service.js";
import type {
  StudioHistoricalResourceSnapshot,
  StudioResourceHistoryPort
} from "../../../src/studio/application/history/ports.js";
import type { StudioDraftItem } from "../../../src/studio/contracts/draft-authoring.js";

const BASE_REVISION = "a".repeat(40);
const TARGET_REVISION = "b".repeat(40);
const RESOURCE = { kind: "agent", id: "reviewer" } as const;

function snapshot(
  revisionId: string,
  content: string
): StudioHistoricalResourceSnapshot {
  const bytes = Buffer.from(content, "utf8");
  const definition = Buffer.from(
    [
      "id: reviewer",
      "description: Reviewer",
      "model_profile: fast",
      "mode: read_only",
      "instructions_file: instructions.md",
      "output_schema: output.schema.json",
      ""
    ].join("\n"),
    "utf8"
  );
  return {
    resource: RESOURCE,
    revisionId,
    files: [
      {
        file: { root: "project", path: "agents/reviewer/agent.yaml" },
        content: definition,
        sha256: studioAuthoringContentDigest(definition),
        mode: 0o644
      },
      {
        file: { root: "project", path: "agents/reviewer/output.schema.json" },
        content: bytes,
        sha256: studioAuthoringContentDigest(bytes),
        mode: 0o644
      }
    ]
  };
}

function draftItem(): StudioDraftItem {
  return {
    draft_id: "5bbc0ae8-d9f1-4cc2-b704-8186c026ad38",
    record_revision: 1,
    content_revision: 1,
    layout_revision: 0,
    primary_resource: RESOURCE,
    status: "dirty",
    draft_hash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    etag: '"studio-draft:test"',
    files: [],
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z"
  };
}

describe("StudioResourceHistoryService", () => {
  it("compares revisions concurrently through redacted canonical apply diffs", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const snapshots = new Map([
      [BASE_REVISION, snapshot(BASE_REVISION, '{"token":"old-secret"}\n')],
      [
        TARGET_REVISION,
        snapshot(TARGET_REVISION, `{"token":"${secret}","ok":true}\n`)
      ]
    ]);
    const history: StudioResourceHistoryPort = {
      list: vi.fn(),
      snapshot: vi.fn(async (_resource, revisionId) => {
        const value = snapshots.get(revisionId);
        if (value === undefined) {
          throw new Error("missing test snapshot");
        }
        return value;
      })
    };
    const service = new StudioResourceHistoryService({
      history,
      restore: { createFromHistory: vi.fn() }
    });

    const result = await service.compare(RESOURCE, {
      base_revision_id: BASE_REVISION,
      target_revision_id: TARGET_REVISION
    });

    expect(result.diff).toHaveLength(1);
    expect(result.diff[0]).toMatchObject({ kind: "modified", redacted: true });
    expect(result.diff[0]?.textual_diff).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(history.snapshot).toHaveBeenCalledTimes(2);
  });

  it("requires explicit confirmation before loading a restore snapshot", async () => {
    const history: StudioResourceHistoryPort = {
      list: vi.fn(),
      snapshot: vi.fn()
    };
    const restore = { createFromHistory: vi.fn() };
    const service = new StudioResourceHistoryService({ history, restore });

    await expect(
      service.restore(RESOURCE, {
        revision_id: TARGET_REVISION,
        confirm_restore_as_new_draft: false
      } as never)
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(history.snapshot).not.toHaveBeenCalled();
    expect(restore.createFromHistory).not.toHaveBeenCalled();
  });

  it("rejects a snapshot bound to a different resource or revision", async () => {
    const mismatched: StudioHistoricalResourceSnapshot = {
      ...snapshot(TARGET_REVISION, '{"type":"object"}\n'),
      resource: { kind: "agent", id: "other-agent" }
    };
    const history: StudioResourceHistoryPort = {
      list: vi.fn(),
      snapshot: vi.fn(async () => mismatched)
    };
    const restore = { createFromHistory: vi.fn() };
    const service = new StudioResourceHistoryService({ history, restore });

    await expect(
      service.restore(RESOURCE, {
        revision_id: TARGET_REVISION,
        confirm_restore_as_new_draft: true
      })
    ).rejects.toMatchObject({ code: "studio_history_resource_invalid" });
    expect(restore.createFromHistory).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical entity path returned by a history port", async () => {
    const target = snapshot(TARGET_REVISION, '{"type":"object"}\n');
    const malformed: StudioHistoricalResourceSnapshot = {
      ...target,
      files: target.files.map((file, index) =>
        index === 0
          ? {
              ...file,
              file: {
                root: "project",
                path: "agents/reviewer/../outside/agent.yaml"
              }
            }
          : file
      )
    };
    const service = new StudioResourceHistoryService({
      history: {
        list: vi.fn(),
        snapshot: vi.fn(async () => malformed)
      },
      restore: { createFromHistory: vi.fn() }
    });

    await expect(
      service.compare(RESOURCE, {
        base_revision_id: TARGET_REVISION,
        target_revision_id: TARGET_REVISION
      })
    ).rejects.toMatchObject({ code: "studio_history_resource_invalid" });
  });

  it("rejects a comparison whose union exceeds the DTO file limit", async () => {
    const manyFiles = (
      revisionId: string,
      start: number,
      count: number
    ): StudioHistoricalResourceSnapshot => ({
      resource: RESOURCE,
      revisionId,
      files: [
        (() => {
          const content = Buffer.from(
            "id: reviewer\ndescription: Reviewer\nmodel_profile: fast\nmode: read_only\ninstructions_file: instructions.md\noutput_schema: output.schema.json\n",
            "utf8"
          );
          return {
            file: {
              root: "project" as const,
              path: "agents/reviewer/agent.yaml"
            },
            content,
            sha256: studioAuthoringContentDigest(content),
            mode: 0o644
          };
        })(),
        ...Array.from({ length: count }, (_, offset) => {
          const content = Buffer.from(`${start + offset}\n`, "utf8");
          return {
            file: {
              root: "project" as const,
              path: `agents/reviewer/files/${start + offset}.md`
            },
            content,
            sha256: studioAuthoringContentDigest(content),
            mode: 0o644
          };
        })
      ]
    });
    const snapshots = new Map([
      [BASE_REVISION, manyFiles(BASE_REVISION, 0, 64)],
      [TARGET_REVISION, manyFiles(TARGET_REVISION, 64, 64)]
    ]);
    const service = new StudioResourceHistoryService({
      history: {
        list: vi.fn(),
        snapshot: vi.fn(async (_resource, revisionId) => {
          const value = snapshots.get(revisionId);
          if (value === undefined) {
            throw new Error("missing test snapshot");
          }
          return value;
        })
      },
      restore: { createFromHistory: vi.fn() }
    });

    await expect(
      service.compare(RESOURCE, {
        base_revision_id: BASE_REVISION,
        target_revision_id: TARGET_REVISION
      })
    ).rejects.toMatchObject({ code: "studio_history_source_too_large" });
  });

  it("returns the ordinary draft produced by a confirmed restore", async () => {
    const target = snapshot(TARGET_REVISION, '{"type":"object"}\n');
    const history: StudioResourceHistoryPort = {
      list: vi.fn(),
      snapshot: vi.fn(async () => target)
    };
    const draft = draftItem();
    const restore = { createFromHistory: vi.fn(async () => draft) };
    const service = new StudioResourceHistoryService({ history, restore });

    await expect(
      service.restore(RESOURCE, {
        revision_id: TARGET_REVISION,
        confirm_restore_as_new_draft: true
      })
    ).resolves.toEqual({
      resource: RESOURCE,
      revision_id: TARGET_REVISION,
      draft
    });
    expect(restore.createFromHistory).toHaveBeenCalledWith(target);
  });
});
