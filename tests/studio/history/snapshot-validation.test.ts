import { describe, expect, it } from "vitest";
import { studioAuthoringContentDigest } from "../../../src/studio/application/drafts/authoring-digests.js";
import { assertStudioHistoricalSnapshot } from "../../../src/studio/application/history/snapshot-validation.js";
import type {
  StudioHistoricalResourceFile,
  StudioHistoricalResourceSnapshot
} from "../../../src/studio/application/history/ports.js";
import { STUDIO_RESOURCE_HISTORY_LIMITS } from "../../../src/studio/contracts/resource-history.js";

const REVISION = "a".repeat(40);
const RESOURCE = { kind: "agent", id: "reviewer" } as const;

function file(
  path: string,
  content: Uint8Array | string
): StudioHistoricalResourceFile {
  const bytes = typeof content === "string"
    ? Buffer.from(content, "utf8")
    : content;
  return {
    file: { root: "project", path },
    content: bytes,
    sha256: studioAuthoringContentDigest(bytes),
    mode: 0o644
  };
}

function snapshot(
  files: readonly StudioHistoricalResourceFile[]
): StudioHistoricalResourceSnapshot {
  return { resource: RESOURCE, revisionId: REVISION, files };
}

const definition = file(
  "agents/reviewer/agent.yaml",
  "id: reviewer\ndescription: Reviewer\nmodel_profile: fast\nmode: read_only\ninstructions_file: instructions.md\noutput_schema: output.schema.json\n"
);

describe("historical snapshot validation", () => {
  it("accepts a canonical, digest-bound entity snapshot", () => {
    expect(() => assertStudioHistoricalSnapshot(snapshot([definition])))
      .not.toThrow();
  });

  it("rejects credential-sensitive files from an untrusted history port", () => {
    expect(() => assertStudioHistoricalSnapshot(snapshot([
      definition,
      file("agents/reviewer/.env", "TOKEN=never-return\n")
    ]))).toThrowError(
      expect.objectContaining({ code: "studio_history_resource_invalid" })
    );
  });

  it("rejects non-UTF-8 entity content", () => {
    expect(() => assertStudioHistoricalSnapshot(snapshot([
      file("agents/reviewer/agent.yaml", Uint8Array.from([0xff, 0xfe]))
    ]))).toThrowError(
      expect.objectContaining({ code: "studio_history_resource_invalid" })
    );
  });

  it("rejects one file before it can exceed the shared snapshot budget", () => {
    expect(() => assertStudioHistoricalSnapshot(snapshot([
      file(
        "agents/reviewer/agent.yaml",
        Buffer.alloc(
          STUDIO_RESOURCE_HISTORY_LIMITS.maxSnapshotFileBytes + 1,
          0x61
        )
      )
    ]))).toThrowError(
      expect.objectContaining({ code: "studio_history_source_too_large" })
    );
  });

  it("requires the canonical entity definition file", () => {
    expect(() => assertStudioHistoricalSnapshot(snapshot([
      file("agents/reviewer/output.schema.json", "{}\n")
    ]))).toThrowError(
      expect.objectContaining({ code: "studio_history_resource_invalid" })
    );
  });
});
