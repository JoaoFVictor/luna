import { describe, expect, it } from "vitest";
import { sha256Digest } from "../../../src/core/workflow/definition-digests.js";
import {
  createStudioChangeSet,
  replaceStudioDraftContent,
  replaceStudioDraftLayout,
  replaceStudioDraftStatus
} from "../../../src/studio/application/drafts/change-set.js";
import { StudioChangeSetSchema } from "../../../src/studio/contracts/drafts.js";
import { StudioPathSchema } from "../../../src/studio/contracts/paths.js";

const draftId = "061d1b5f-a620-4ba7-990d-331b31cf74af";
const workflowFile = {
  root: "project",
  path: "workflows/review/workflow.yaml"
} as const;

function digest(value: string): string {
  return sha256Digest(value);
}

function draftInput() {
  return {
    draftId,
    primaryResource: { kind: "workflow", id: "review" },
    resources: [{ kind: "workflow", id: "review" }],
    resourceRevisions: { "workflow:review": digest("revision") },
    baseBundleHash: digest("bundle"),
    technicalCatalogFingerprint: digest("technical"),
    presentationCatalogFingerprint: digest("presentation"),
    baseFiles: [
      {
        file: workflowFile,
        sha256: digest("old"),
        content_ref: digest("old")
      }
    ],
    dependencies: [],
    allowedFiles: [workflowFile],
    changes: [
      {
        action: "write",
        file: workflowFile,
        base_sha256: digest("old"),
        content_sha256: digest("new"),
        content_ref: digest("new")
      }
    ],
    now: "2026-07-10T12:00:00.000Z"
  } as const;
}

function draft() {
  return createStudioChangeSet(draftInput());
}

describe("Studio change sets", () => {
  it("creates a server-owned, deterministic content identity", () => {
    const first = draft();
    const second = draft();

    expect(first).toEqual(second);
    expect(first.draft_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.record_revision).toBe(1);
    expect(first.content_revision).toBe(1);
    expect(first.layout_revision).toBe(0);
  });

  it.each([
    "record_revision",
    "content_revision",
    "layout_revision"
  ] as const)("rejects unsafe integer %s values", (field) => {
    expect(
      StudioChangeSetSchema.safeParse({
        ...draft(),
        [field]: Number.MAX_SAFE_INTEGER + 1
      }).success
    ).toBe(false);
  });

  it("keeps layout revisions separate from apply content identity", () => {
    const current = draft();
    const moved = replaceStudioDraftLayout(
      current,
      { nodes: { preflight: { x: 120, y: 80 } } },
      "2026-07-10T12:01:00.000Z"
    );

    expect(moved.draft_hash).toBe(current.draft_hash);
    expect(moved.record_revision).toBe(2);
    expect(moved.content_revision).toBe(current.content_revision);
    expect(moved.layout_revision).toBe(1);
  });

  it("invalidates content identity when a file change is replaced", () => {
    const current = draft();
    const updated = replaceStudioDraftContent(
      current,
      [
        {
          action: "write",
          file: workflowFile,
          base_sha256: digest("old"),
          content_sha256: digest("newer"),
          content_ref: digest("newer")
        }
      ],
      "2026-07-10T12:02:00.000Z"
    );

    expect(updated.draft_hash).not.toBe(current.draft_hash);
    expect(updated.record_revision).toBe(2);
    expect(updated.content_revision).toBe(2);
    expect(updated.layout_revision).toBe(0);
  });

  it("rejects a semantically identical content replacement as a no-op", () => {
    const current = draft();

    expect(() =>
      replaceStudioDraftContent(
        current,
        [...current.changes],
        "2026-07-10T12:02:00.000Z"
      )
    ).toThrow(
      expect.objectContaining({ code: "draft_noop_update" })
    );
    expect(current).toMatchObject({
      record_revision: 1,
      content_revision: 1
    });
  });

  it("rejects a semantically identical layout replacement as a no-op", () => {
    const current = replaceStudioDraftLayout(
      draft(),
      { selected: "node-a" },
      "2026-07-10T12:01:00.000Z"
    );

    expect(() =>
      replaceStudioDraftLayout(
        current,
        { selected: "node-a" },
        "2026-07-10T12:02:00.000Z"
      )
    ).toThrow(
      expect.objectContaining({ code: "draft_noop_update" })
    );
    expect(current).toMatchObject({
      record_revision: 2,
      layout_revision: 1
    });
  });

  it("records validation status without pretending content or layout changed", () => {
    const current = draft();
    const validated = replaceStudioDraftStatus(
      current,
      "valid",
      "2026-07-10T12:03:00.000Z"
    );

    expect(validated.status).toBe("valid");
    expect(validated.record_revision).toBe(2);
    expect(validated.content_revision).toBe(current.content_revision);
    expect(validated.layout_revision).toBe(current.layout_revision);
    expect(validated.draft_hash).toBe(current.draft_hash);
  });

  it("requires exactly one canonical resource revision per resource", () => {
    expect(() =>
      createStudioChangeSet({
        ...draftInput(),
        resourceRevisions: {}
      })
    ).toThrow(/exactly match draft resources/);
  });

  it("requires every base file to be server-authorized", () => {
    expect(() =>
      createStudioChangeSet({
        ...draftInput(),
        allowedFiles: [],
        changes: []
      })
    ).toThrow(/Base file is not server-authorized/);
  });

  it("keeps base files and dependencies in disjoint roles", () => {
    expect(() =>
      createStudioChangeSet({
        ...draftInput(),
        dependencies: [{ file: workflowFile, sha256: digest("old") }]
      })
    ).toThrow(/both a base file and dependency/);
  });

  it("requires each change base hash to match its base file entry", () => {
    expect(() =>
      createStudioChangeSet({
        ...draftInput(),
        changes: [
          {
            ...draftInput().changes[0],
            base_sha256: digest("different-base")
          }
        ]
      })
    ).toThrow(/base hash does not match/);
  });

  it("requires every change to have an explicit base file entry", () => {
    expect(() =>
      createStudioChangeSet({
        ...draftInput(),
        baseFiles: []
      })
    ).toThrow(/no base file entry/);
  });

  it("uses a null base entry for a newly created file", () => {
    const created = createStudioChangeSet({
      ...draftInput(),
      baseFiles: [{ file: workflowFile, sha256: null, content_ref: null }],
      changes: [
        {
          action: "write",
          file: workflowFile,
          base_sha256: null,
          content_sha256: digest("new"),
          content_ref: digest("new")
        }
      ]
    });

    expect(created.changes[0]?.base_sha256).toBeNull();
  });

  it("keeps a base file hash identical to its content address", () => {
    expect(() =>
      createStudioChangeSet({
        ...draftInput(),
        baseFiles: [
          {
            file: workflowFile,
            sha256: digest("old"),
            content_ref: digest("different-content")
          }
        ]
      })
    ).toThrow(/content reference does not match/);
  });

  it("requires a non-null base before a file can be deleted", () => {
    expect(() =>
      createStudioChangeSet({
        ...draftInput(),
        baseFiles: [
          { file: workflowFile, sha256: null, content_ref: null }
        ],
        changes: [
          {
            action: "delete",
            file: workflowFile,
            base_sha256: digest("not-a-real-base")
          }
        ]
      })
    ).toThrow(/base hash does not match|cannot be deleted/);
  });

  it("rejects client changes outside the server-authorized file set", () => {
    expect(() =>
      createStudioChangeSet({
        draftId,
        primaryResource: { kind: "workflow", id: "review" },
        resources: [{ kind: "workflow", id: "review" }],
        resourceRevisions: { "workflow:review": null },
        baseBundleHash: null,
        technicalCatalogFingerprint: digest("technical"),
        presentationCatalogFingerprint: digest("presentation"),
        baseFiles: [],
        dependencies: [],
        allowedFiles: [workflowFile],
        changes: [
          {
            action: "delete",
            file: {
              root: "project",
              path: "agents/reviewer/agent.yaml"
            },
            base_sha256: digest("agent")
          }
        ],
        now: "2026-07-10T12:00:00.000Z"
      })
    ).toThrow(/not server-authorized/);
  });
});

describe("Studio logical paths", () => {
  it.each([
    "/etc/passwd",
    "../outside",
    "workflows//review",
    "workflows/./review",
    "workflows\\review",
    "C:/outside",
    "workflows/review\nsecret"
  ])("rejects non-canonical or escaping path %s", (candidate) => {
    expect(
      StudioPathSchema.safeParse({ root: "project", path: candidate }).success
    ).toBe(false);
  });
});
