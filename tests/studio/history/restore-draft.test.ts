import { describe, expect, it, vi } from "vitest";
import { StudioHistoricalDraftRestore } from "../../../src/studio/application/history/restore-draft.js";
import { studioAuthoringContentDigest } from "../../../src/studio/application/drafts/authoring-digests.js";
import type { StudioHistoricalResourceSnapshot } from "../../../src/studio/application/history/ports.js";
import { studioPathKey } from "../../../src/studio/contracts/paths.js";
import {
  AUTHORING_DRAFT_ID,
  MemoryAuthoringDrafts,
  PRESENTATION_FINGERPRINT,
  RESOURCE_REVISION,
  TECHNICAL_FINGERPRINT,
  memoryAuthoringSource
} from "../drafts/authoring-test-support.js";

const NOW = new Date("2026-07-11T00:00:00.000Z");
const REVISION = "d".repeat(40);

function historicalFile(path: string, content: string, mode = 0o644) {
  const bytes = Buffer.from(content, "utf8");
  return {
    file: { root: "project" as const, path },
    content: bytes,
    sha256: studioAuthoringContentDigest(bytes),
    mode
  };
}

function restorer(
  drafts: MemoryAuthoringDrafts,
  files: Readonly<Record<string, string | { content: string; mode: number }>>,
  revision: string | null = RESOURCE_REVISION,
  lifecycle: {
    readonly now?: () => Date;
    readonly randomDraftId?: () => string;
  } = {}
) {
  return new StudioHistoricalDraftRestore({
    drafts,
    source: memoryAuthoringSource(files),
    revisions: { current: async () => revision },
    catalogs: {
      technical: () => TECHNICAL_FINGERPRINT,
      presentation: () => PRESENTATION_FINGERPRINT
    },
    now: lifecycle.now ?? (() => NOW),
    randomDraftId: lifecycle.randomDraftId ?? (() => AUTHORING_DRAFT_ID)
  });
}

describe("StudioHistoricalDraftRestore", () => {
  it("creates a reviewable draft, deletes current-only files, and pins collisions", async () => {
    const currentDefinition = [
      "id: reviewer",
      "description: Current reviewer",
      "model_profile: default",
      "mode: read_only",
      "instructions_file: current.md",
      "output_schema: output.schema.json",
      ""
    ].join("\n");
    const historicalDefinition = currentDefinition
      .replace("Current reviewer", "Historical reviewer")
      .replace("current.md", "historical.md");
    const files = {
      "project:agents/reviewer/agent.yaml": currentDefinition,
      "project:agents/reviewer/current.md": "current instructions\n",
      "project:agents/reviewer/historical.md":
        "unreferenced current collision\n",
      "project:agents/reviewer/output.schema.json":
        '{"type":"object","required":["current"]}\n'
    };
    const snapshot: StudioHistoricalResourceSnapshot = {
      resource: { kind: "agent", id: "reviewer" },
      revisionId: REVISION,
      files: [
        historicalFile("agents/reviewer/agent.yaml", historicalDefinition),
        historicalFile(
          "agents/reviewer/historical.md",
          "historical instructions\n"
        ),
        historicalFile(
          "agents/reviewer/output.schema.json",
          '{"type":"object","required":["historical"]}\n'
        )
      ]
    };
    const drafts = new MemoryAuthoringDrafts();

    const result = await restorer(drafts, files).createFromHistory(snapshot);

    expect(result.files).toEqual([
      expect.objectContaining({
        file: { root: "project", path: "agents/reviewer/agent.yaml" },
        state: "present",
        content: historicalDefinition
      }),
      expect.objectContaining({
        file: { root: "project", path: "agents/reviewer/current.md" },
        state: "deleted"
      }),
      expect.objectContaining({
        file: { root: "project", path: "agents/reviewer/historical.md" },
        state: "present",
        content: "historical instructions\n"
      }),
      expect.objectContaining({
        file: {
          root: "project",
          path: "agents/reviewer/output.schema.json"
        },
        state: "present"
      })
    ]);
    const changeSet = drafts.draft;
    expect(changeSet).toBeDefined();
    expect(changeSet?.status).toBe("dirty");
    expect(changeSet?.dependencies).toEqual([]);
    expect(
      changeSet?.base_files.find(
        (base) => base.file.path === "agents/reviewer/historical.md"
      )?.sha256
    ).toBe(
      studioAuthoringContentDigest(
        Buffer.from("unreferenced current collision\n", "utf8")
      )
    );
    expect(changeSet?.changes.map((change) => [change.action, change.file.path]))
      .toEqual([
        ["write", "agents/reviewer/agent.yaml"],
        ["delete", "agents/reviewer/current.md"],
        ["write", "agents/reviewer/historical.md"],
        ["write", "agents/reviewer/output.schema.json"]
      ]);
  });

  it("resolves restored workflow dependencies from current source", async () => {
    const currentWorkflow = [
      "id: pipeline",
      "type: workflow",
      "capabilities: []",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "nodes:",
      "  - id: current",
      "    type: agent",
      "    agent: current-agent",
      "    output_schema: output.schema.json",
      ""
    ].join("\n");
    const historicalWorkflow = currentWorkflow
      .replace("id: current", "id: historical")
      .replace("current-agent", "historical-agent");
    const agentDefinition = (id: string) =>
      [
        `id: ${id}`,
        `description: ${id}`,
        "model_profile: default",
        "mode: read_only",
        "instructions_file: instructions.md",
        "output_schema: output.schema.json",
        ""
      ].join("\n");
    const files = {
      "project:workflows/pipeline/workflow.yaml": currentWorkflow,
      "project:workflows/pipeline/input.schema.json": '{"type":"object"}\n',
      "project:workflows/pipeline/output.schema.json": '{"type":"object"}\n',
      "project:agents/current-agent/agent.yaml": agentDefinition("current-agent"),
      "project:agents/current-agent/instructions.md": "current agent\n",
      "project:agents/current-agent/output.schema.json": '{"type":"object"}\n',
      "project:agents/historical-agent/agent.yaml":
        agentDefinition("historical-agent"),
      "project:agents/historical-agent/instructions.md":
        "current version of historical agent\n",
      "project:agents/historical-agent/output.schema.json":
        '{"type":"object","properties":{"current":{"type":"boolean"}}}\n'
    };
    const snapshot: StudioHistoricalResourceSnapshot = {
      resource: { kind: "workflow", id: "pipeline" },
      revisionId: REVISION,
      files: [
        historicalFile(
          "workflows/pipeline/workflow.yaml",
          historicalWorkflow
        ),
        historicalFile(
          "workflows/pipeline/input.schema.json",
          '{"type":"object","required":["historical"]}\n'
        ),
        historicalFile(
          "workflows/pipeline/output.schema.json",
          '{"type":"object"}\n'
        )
      ]
    };
    const drafts = new MemoryAuthoringDrafts();

    await restorer(drafts, files).createFromHistory(snapshot);

    const dependencyKeys = drafts.draft?.dependencies.map((dependency) =>
      studioPathKey(dependency.file)
    );
    expect(dependencyKeys).toEqual([
      "project:agents/historical-agent/agent.yaml",
      "project:agents/historical-agent/instructions.md",
      "project:agents/historical-agent/output.schema.json"
    ]);
    expect(dependencyKeys).not.toContain(
      "project:agents/current-agent/agent.yaml"
    );
  });

  it("restores a resource deleted from current source as an ordinary new draft", async () => {
    const definition = [
      "id: revived",
      "description: Revived agent",
      "model_profile: default",
      "mode: read_only",
      "instructions_file: instructions.md",
      "output_schema: output.schema.json",
      ""
    ].join("\n");
    const snapshot: StudioHistoricalResourceSnapshot = {
      resource: { kind: "agent", id: "revived" },
      revisionId: REVISION,
      files: [
        historicalFile("agents/revived/agent.yaml", definition),
        historicalFile("agents/revived/instructions.md", "revived\n"),
        historicalFile(
          "agents/revived/output.schema.json",
          '{"type":"object"}\n'
        )
      ]
    };
    const drafts = new MemoryAuthoringDrafts();

    const result = await restorer(drafts, {}, null).createFromHistory(snapshot);

    expect(result.files).toHaveLength(3);
    expect(result.files.every((file) => file.state === "present")).toBe(true);
    expect(drafts.draft?.base_files.every((base) => base.sha256 === null)).toBe(
      true
    );
    expect(drafts.draft?.changes.every((change) => change.action === "write"))
      .toBe(true);
  });

  it("rejects a restore that already matches current bytes and modes", async () => {
    const definition = [
      "id: same",
      "description: Same agent",
      "model_profile: default",
      "mode: read_only",
      "instructions_file: instructions.md",
      "output_schema: output.schema.json",
      ""
    ].join("\n");
    const files = {
      "project:agents/same/agent.yaml": definition,
      "project:agents/same/instructions.md": "same\n",
      "project:agents/same/output.schema.json": '{"type":"object"}\n'
    };
    const snapshot: StudioHistoricalResourceSnapshot = {
      resource: { kind: "agent", id: "same" },
      revisionId: REVISION,
      files: [
        historicalFile("agents/same/agent.yaml", definition),
        historicalFile("agents/same/instructions.md", "same\n"),
        historicalFile(
          "agents/same/output.schema.json",
          '{"type":"object"}\n'
        )
      ]
    };

    await expect(
      restorer(new MemoryAuthoringDrafts(), files).createFromHistory(snapshot)
    ).rejects.toMatchObject({ code: "studio_history_restore_noop" });
  });

  it("strictly advances timestamps when the history clock repeats or regresses", async () => {
    const definition = [
      "id: historical-clock",
      "description: Historical clock",
      "model_profile: default",
      "mode: read_only",
      "instructions_file: instructions.md",
      "output_schema: output.schema.json",
      ""
    ].join("\n");
    const files = {
      "project:agents/historical-clock/agent.yaml": definition.replace(
        "Historical clock",
        "Current clock"
      ),
      "project:agents/historical-clock/instructions.md": "current\n",
      "project:agents/historical-clock/output.schema.json": "{\"type\":\"object\"}\n"
    };
    const snapshot: StudioHistoricalResourceSnapshot = {
      resource: { kind: "agent", id: "historical-clock" },
      revisionId: REVISION,
      files: [
        historicalFile("agents/historical-clock/agent.yaml", definition),
        historicalFile("agents/historical-clock/instructions.md", "historical\n"),
        historicalFile(
          "agents/historical-clock/output.schema.json",
          "{\"type\":\"object\",\"required\":[\"historical\"]}\n"
        )
      ]
    };
    const later = new Date("2026-07-11T00:00:01.000Z");
    const earlier = new Date("2026-07-11T00:00:00.000Z");
    const clock = vi
      .fn<() => Date>()
      .mockReturnValueOnce(later)
      .mockReturnValue(earlier);
    const draftIds = vi
      .fn<() => string>()
      .mockReturnValueOnce(AUTHORING_DRAFT_ID)
      .mockReturnValue("40a5ae5e-1da2-4f62-8758-4451b3652884");
    const drafts = new MemoryAuthoringDrafts();
    const restore = restorer(drafts, files, RESOURCE_REVISION, {
      now: clock,
      randomDraftId: draftIds
    });

    const first = await restore.createFromHistory(snapshot);
    drafts.draft = undefined;
    drafts.blobs.clear();
    const second = await restore.createFromHistory(snapshot);

    expect(Date.parse(second.updated_at)).toBe(
      Date.parse(first.updated_at) + 1
    );
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("preserves the canonical create conflict across the history surface", async () => {
    const current = [
      "id: history-conflict",
      "description: Current",
      "model_profile: default",
      "mode: read_only",
      "instructions_file: instructions.md",
      "output_schema: output.schema.json",
      ""
    ].join("\n");
    const files = {
      "project:agents/history-conflict/agent.yaml": current,
      "project:agents/history-conflict/instructions.md": "current\n",
      "project:agents/history-conflict/output.schema.json": "{\"type\":\"object\"}\n"
    };
    const snapshot: StudioHistoricalResourceSnapshot = {
      resource: { kind: "agent", id: "history-conflict" },
      revisionId: REVISION,
      files: [
        historicalFile(
          "agents/history-conflict/agent.yaml",
          current.replace("description: Current", "description: Historical")
        ),
        historicalFile("agents/history-conflict/instructions.md", "historical\n"),
        historicalFile(
          "agents/history-conflict/output.schema.json",
          "{\"type\":\"object\",\"required\":[\"historical\"]}\n"
        )
      ]
    };
    const drafts = new MemoryAuthoringDrafts();
    const restore = restorer(drafts, files);
    await restore.createFromHistory(snapshot);

    await expect(restore.createFromHistory(snapshot)).rejects.toMatchObject({
      code: "studio_draft_already_exists"
    });
  });
});
