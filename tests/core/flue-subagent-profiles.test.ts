import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveFlueSubagentProfiles } from "../../src/core/flue-subagent-profiles.js";

describe("flue subagent profiles", () => {
  it("resolves existing Luna agents into Flue subagent profiles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-subagents-"));
    const reviewerDir = path.join(root, "implementation-reviewer");
    await mkdir(reviewerDir, { recursive: true });
    await writeFile(
      path.join(reviewerDir, "agent.yaml"),
      [
        "id: implementation-reviewer",
        "description: Reviews implementation diffs",
        "model_profile: deep",
        "mode: read_only",
        "instructions_file: instructions.md",
        "output_schema: output.schema.json",
        ""
      ].join("\n")
    );
    await writeFile(path.join(reviewerDir, "instructions.md"), "Review the diff.\n");
    await writeFile(path.join(reviewerDir, "output.schema.json"), "{}\n");

    const profiles = await resolveFlueSubagentProfiles({
      agentsRoot: root,
      ids: ["implementation-reviewer"],
      modelProfiles: {
        deep: { model: "test/deep", reasoning_effort: "high" }
      }
    });

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      name: "implementation-reviewer",
      description: "Reviews implementation diffs",
      model: "test/deep",
      thinkingLevel: "high"
    });
    expect(String(profiles[0]?.instructions)).toContain("Review the diff.");
  });

  it("rejects a subagent that references its parent id", async () => {
    await expect(
      resolveFlueSubagentProfiles({
        agentsRoot: "/agents",
        parentAgentId: "code-implementer",
        ids: ["code-implementer"],
        modelProfiles: {}
      })
    ).rejects.toMatchObject({ code: "subagent_self_reference" });
  });

  it("rejects subagents with missing model profiles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-subagents-"));
    const reviewerDir = path.join(root, "implementation-reviewer");
    await mkdir(reviewerDir, { recursive: true });
    await writeFile(
      path.join(reviewerDir, "agent.yaml"),
      [
        "id: implementation-reviewer",
        "description: Reviews implementation diffs",
        "model_profile: missing",
        "mode: read_only",
        "instructions_file: instructions.md",
        "output_schema: output.schema.json",
        ""
      ].join("\n")
    );
    await writeFile(path.join(reviewerDir, "instructions.md"), "Review the diff.\n");
    await writeFile(path.join(reviewerDir, "output.schema.json"), "{}\n");

    await expect(
      resolveFlueSubagentProfiles({
        agentsRoot: root,
        ids: ["implementation-reviewer"],
        modelProfiles: {}
      })
    ).rejects.toMatchObject({ code: "subagent_model_profile_missing" });
  });
});
