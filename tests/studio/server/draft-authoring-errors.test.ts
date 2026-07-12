import { describe, expect, it } from "vitest";
import { StudioApplyError } from "../../../src/studio/application/apply/errors.js";
import { StudioDraftAuthoringError } from "../../../src/studio/application/drafts/authoring-errors.js";
import { StudioDraftPersistenceError } from "../../../src/studio/application/drafts/persistence.js";
import { studioDraftAuthoringHttpError } from "../../../src/studio/server/draft-authoring-errors.js";

describe("Studio draft authoring HTTP errors", () => {
  it("maps preconditions to standard safe statuses", () => {
    expect(
      studioDraftAuthoringHttpError(
        new StudioDraftAuthoringError(
          "studio_draft_authoring_precondition_required",
          "internal detail"
        )
      )
    ).toEqual({
      statusCode: 428,
      code: "studio_draft_authoring_precondition_required",
      message: "This Studio command requires If-Match"
    });
    expect(
      studioDraftAuthoringHttpError(
        new StudioDraftAuthoringError(
          "studio_draft_authoring_precondition_failed",
          "internal detail"
        )
      )
    ).toMatchObject({ statusCode: 412 });
  });

  it("does not expose filesystem causes through source errors", () => {
    const mapped = studioDraftAuthoringHttpError(
      new StudioDraftAuthoringError(
        "studio_draft_authoring_source_invalid",
        "failed at /home/private/project/secrets.yaml",
        { cause: new Error("EACCES /home/private/project/secrets.yaml") }
      )
    );

    expect(mapped).toEqual({
      statusCode: 400,
      code: "studio_draft_authoring_source_invalid",
      message: "The Studio authoring command is invalid"
    });
    expect(JSON.stringify(mapped)).not.toContain("/home/private");
  });

  it("maps an unavailable model profile to a safe conflict", () => {
    expect(
      studioDraftAuthoringHttpError(
        new StudioDraftAuthoringError(
          "studio_draft_authoring_model_profile_unavailable",
          "private profile detail"
        )
      )
    ).toEqual({
      statusCode: 409,
      code: "studio_draft_authoring_model_profile_unavailable",
      message: "The Studio authoring command conflicts with current state"
    });
  });

  it("maps dirty closure conflicts to bounded actionable 409 details", () => {
    const files = ["a.json", "b.json", "c.json", "d.json"].map((name) => ({
      root: "project" as const,
      path: `workflows/review/${name}`
    }));
    const first = files[0];
    if (first === undefined) throw new Error("Expected a conflict file");
    expect(
      studioDraftAuthoringHttpError(
        new StudioDraftAuthoringError(
          "studio_draft_authoring_dirty_file_conflict",
          "private conflict detail",
          {
            details: {
              file: first,
              files,
              fieldPath: "$.edits[1].content",
              actualEntries: files.length
            }
          }
        )
      )
    ).toEqual({
      statusCode: 409,
      code: "studio_draft_authoring_dirty_file_conflict",
      message: "The definition change conflicts with dirty draft files",
      details: {
        field_path: "$.edits[1].content",
        path: "project:workflows/review/a.json",
        dirty_paths: [
          "project:workflows/review/a.json",
          "project:workflows/review/b.json",
          "project:workflows/review/c.json"
        ].join("\n"),
        dirty_path_count: 4,
        dirty_paths_truncated: true
      }
    });
  });

  it("maps persistence and apply failures without forwarding internal messages", () => {
    expect(
      studioDraftAuthoringHttpError(
        new StudioDraftPersistenceError(
          "studio_storage_io_failed",
          "host path and errno"
        )
      )
    ).toEqual({
      statusCode: 500,
      code: "studio_storage_io_failed",
      message: "The Studio draft could not be read or persisted safely"
    });
    expect(
      studioDraftAuthoringHttpError(
        new StudioApplyError(
          "studio_apply_source_conflict",
          "internal conflict detail"
        )
      )
    ).toEqual({
      statusCode: 409,
      code: "studio_apply_source_conflict",
      message: "The confirmed Studio apply plan is no longer usable"
    });
  });
});
