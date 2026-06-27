import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectContextBuiltIn } from "../../src/core/built-ins/context.js";
import { collectContextIntake } from "../../src/capabilities/context/collect-context.js";
import type { WorkflowState } from "../../src/core/workflow/state.js";

async function writeAgent(
  agentsRoot: string,
  agentId: string,
  contextFiles: readonly string[]
): Promise<void> {
  const agentDir = path.join(agentsRoot, agentId);
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "agent.yaml"),
    [
      `id: ${agentId}`,
      "description: Reviews changes",
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

function workflowState(root: string): WorkflowState {
  return {
    repository: {
      id: "repo",
      provider: "github",
      owner: "org",
      name: "repo",
      path: path.join(root, "repo"),
      remote: "origin",
      context: {
        files: ["AGENTS.md", "README.md", "../outside.md"]
      }
    },
    workspace: {
      path: path.join(root, "workspace"),
      base_sha: "base",
      head_sha: "head"
    },
    agentsRoot: path.join(root, "agents")
  } as WorkflowState;
}

describe("collect_context built-in", () => {
  it("collects repository and agent context files with an audit trail", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-context-built-in-"));

    try {
      const workspace = path.join(root, "workspace");
      const agentsRoot = path.join(root, "agents");
      await mkdir(workspace, { recursive: true });
      await writeFile(path.join(workspace, "AGENTS.md"), "# Agent guide\n", "utf8");
      await writeAgent(agentsRoot, "change-reviewer", [
        "review-guidelines.md",
        "missing.md"
      ]);
      await writeFile(
        path.join(agentsRoot, "change-reviewer", "review-guidelines.md"),
        "Use project severity rules.\n",
        "utf8"
      );

      await expect(
        collectContextBuiltIn.run({
          state: workflowState(root),
          input: { agents: ["change-reviewer"] },
          dependencies: { collectContextIntake }
        })
      ).resolves.toEqual({
        kind: "luna.collect_context.v1",
        repository: {
          root: workspace,
          configured: ["AGENTS.md", "README.md", "../outside.md"],
          read: [
            {
              path: "AGENTS.md",
              bytes: 14,
              content: "# Agent guide\n"
            }
          ],
          missing: [{ path: "README.md" }],
          skipped: [{ path: "../outside.md", reason: "path_escape" }]
        },
        agents: [
          {
            id: "change-reviewer",
            root: path.join(agentsRoot, "change-reviewer"),
            configured: ["review-guidelines.md", "missing.md"],
            read: [
              {
                path: "review-guidelines.md",
                bytes: 28,
                content: "Use project severity rules.\n"
              }
            ],
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
