import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectContextIntake } from "../../../src/capabilities/context/collect-context.js";

async function writeAgent(
  agentsRoot: string,
  id: string,
  contextFiles: readonly string[]
): Promise<void> {
  const agentDir = path.join(agentsRoot, id);
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "agent.yaml"),
    [
      `id: ${id}`,
      "description: Reviews work",
      "model_profile: deep",
      "mode: read_only",
      "instructions_file: instructions.md",
      "output_schema: output.schema.json",
      "context:",
      "  files:",
      ...contextFiles.map((file) => `    - ${file}`),
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(agentDir, "instructions.md"), "Review.\n", "utf8");
  await writeFile(path.join(agentDir, "output.schema.json"), "{}\n", "utf8");
}

describe("context capability collect_context", () => {
  it("collects repository context first and agent context second with audit metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-cap-context-"));

    try {
      const repoRoot = path.join(root, "repo");
      const agentsRoot = path.join(root, "agents");
      await mkdir(repoRoot, { recursive: true });
      await writeFile(path.join(repoRoot, "AGENTS.md"), "Repo rules.\n", "utf8");
      await writeAgent(agentsRoot, "reviewer", ["rubric.md", "missing.md"]);
      await writeFile(
        path.join(agentsRoot, "reviewer", "rubric.md"),
        "Agent rubric.\n",
        "utf8"
      );

      await expect(
        collectContextIntake({
          repository: {
            id: "repo",
            provider: "github",
            owner: "org",
            name: "repo",
            path: repoRoot,
            remote: "origin",
            context: { files: ["AGENTS.md", "../outside.md"] }
          },
          repositoryRoot: repoRoot,
          agentsRoot,
          agentIds: ["reviewer"]
        })
      ).resolves.toEqual({
        kind: "luna.collect_context.v1",
        repository: {
          root: repoRoot,
          configured: ["AGENTS.md", "../outside.md"],
          read: [{ path: "AGENTS.md", bytes: 12, content: "Repo rules.\n" }],
          missing: [],
          skipped: [{ path: "../outside.md", reason: "path_escape" }]
        },
        agents: [
          {
            id: "reviewer",
            root: path.join(agentsRoot, "reviewer"),
            configured: ["rubric.md", "missing.md"],
            read: [{ path: "rubric.md", bytes: 14, content: "Agent rubric.\n" }],
            missing: [{ path: "missing.md" }],
            skipped: []
          }
        ]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
