import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveFlueSubagentProfiles } from "../../src/core/flue-subagent-profiles.js";
import type { LunaObservability } from "../../src/core/observability/luna-observability.js";
import { createObservabilitySummary } from "../../src/core/observability/summary.js";

async function writeSkillFixture(root: string): Promise<void> {
  const skillDir = path.join(root, "skills", "repo-inspection");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: repo-inspection",
      "description: Inspect repository state without changing files.",
      "---",
      "",
      "- Read local repository context.",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeSubagentFixture({
  root,
  id = "change-reviewer",
  mode = "read_only",
  extraYaml = []
}: {
  root: string;
  id?: string;
  mode?: "read_only" | "trusted_host_local_write";
  extraYaml?: string[];
}): Promise<void> {
  const reviewerDir = path.join(root, id);
  await mkdir(reviewerDir, { recursive: true });
  await writeFile(
    path.join(reviewerDir, "agent.yaml"),
    [
      `id: ${id}`,
      "description: Reviews implementation diffs",
      "model_profile: deep",
      `mode: ${mode}`,
      "instructions_file: instructions.md",
      "output_schema: output.schema.json",
      ...extraYaml,
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(reviewerDir, "instructions.md"), "Review the diff.\n");
  await writeFile(path.join(reviewerDir, "output.schema.json"), "{}\n");
}

function fakeObservability(): LunaObservability {
  return {
    eventContext: (severity) => ({
      severity,
      run: { id: "run-1", attempt: 1 },
      workflow: { id: "workflow-1" },
      timestamp: "2026-06-20T12:00:00.000Z"
    }),
    emit: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isHardFailed: () => false,
    hardFailure: () => undefined
  };
}

describe("flue subagent profiles", () => {
  it("resolves existing Luna agents into Flue subagent profiles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-subagents-"));

    try {
      const reviewerDir = path.join(root, "change-reviewer");
      await mkdir(reviewerDir, { recursive: true });
      await writeFile(
        path.join(reviewerDir, "agent.yaml"),
        [
          "id: change-reviewer",
          "description: Reviews implementation diffs",
          "model_profile: deep",
          "mode: read_only",
          "instructions_file: instructions.md",
          "output_schema: output.schema.json",
          ""
        ].join("\n")
      );
      await writeFile(
        path.join(reviewerDir, "instructions.md"),
        "Review the diff.\n"
      );
      await writeFile(path.join(reviewerDir, "output.schema.json"), "{}\n");

      const profiles = await resolveFlueSubagentProfiles({
        agentsRoot: root,
        subagents: [{ id: "change-reviewer" }],
        modelProfiles: {
          deep: { model: "test/deep", reasoning_effort: "high" }
        }
      });

      expect(profiles).toHaveLength(1);
      expect(profiles[0]).toMatchObject({
        name: "change-reviewer",
        description: "Reviews implementation diffs",
        model: "test/deep",
        thinkingLevel: "high"
      });
      expect(String(profiles[0]?.instructions)).toContain("Review the diff.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a subagent that references its parent id", async () => {
    await expect(
      resolveFlueSubagentProfiles({
        agentsRoot: "/agents",
        parentAgentId: "code-implementer",
        subagents: [{ id: "code-implementer" }],
        modelProfiles: {}
      })
    ).rejects.toMatchObject({ code: "subagent_self_reference" });
  });

  it("rejects subagents with missing model profiles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-subagents-"));

    try {
      const reviewerDir = path.join(root, "change-reviewer");
      await mkdir(reviewerDir, { recursive: true });
      await writeFile(
        path.join(reviewerDir, "agent.yaml"),
        [
          "id: change-reviewer",
          "description: Reviews implementation diffs",
          "model_profile: missing",
          "mode: read_only",
          "instructions_file: instructions.md",
          "output_schema: output.schema.json",
          ""
        ].join("\n")
      );
      await writeFile(
        path.join(reviewerDir, "instructions.md"),
        "Review the diff.\n"
      );
      await writeFile(path.join(reviewerDir, "output.schema.json"), "{}\n");

      await expect(
        resolveFlueSubagentProfiles({
          agentsRoot: root,
          subagents: [{ id: "change-reviewer" }],
          modelProfiles: {}
        })
      ).rejects.toMatchObject({ code: "subagent_model_profile_missing" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows read-only subagents with skills but no tools", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-subagents-"));
    const agentsRoot = path.join(root, "agents");

    try {
      await writeSkillFixture(root);
      await writeSubagentFixture({
        root: agentsRoot,
        extraYaml: [
          "skills:",
          "  - ../../skills/repo-inspection/SKILL.md"
        ]
      });

      const profiles = await resolveFlueSubagentProfiles({
        agentsRoot,
        subagents: [{ id: "change-reviewer" }],
        cwd: "/repo/worktree",
        modelProfiles: {
          deep: { model: "test/deep", reasoning_effort: "high" }
        }
      });

      expect(profiles).toHaveLength(1);
      expect(profiles[0]?.skills).toEqual([
        expect.objectContaining({
          name: "repo-inspection",
          description: "Inspect repository state without changing files."
        })
      ]);
      expect(profiles[0]?.tools).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects read-only policy overrides with allow_tools", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-subagents-"));

    try {
      await writeSubagentFixture({ root });

      await expect(
        resolveFlueSubagentProfiles({
          agentsRoot: root,
          subagents: [
            {
              id: "change-reviewer",
              policy: { mode: "read_only", allow_tools: ["repository.status"] }
            }
          ],
          workflowSubagentPolicy: { allow_write: true },
          cwd: "/repo/worktree",
          modelProfiles: {
            deep: { model: "test/deep", reasoning_effort: "high" }
          }
        })
      ).rejects.toMatchObject({
        code: "subagent_read_only_allow_tools_invalid"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects read-only subagents that declare tools", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-subagents-"));

    try {
      await writeSubagentFixture({
        root,
        extraYaml: ["tools:", "  - repository.status"]
      });

      await expect(
        resolveFlueSubagentProfiles({
          agentsRoot: root,
          subagents: [{ id: "change-reviewer" }],
          cwd: "/repo/worktree",
          modelProfiles: {
            deep: { model: "test/deep", reasoning_effort: "high" }
          }
        })
      ).rejects.toMatchObject({
        code: "subagent_read_only_allow_tools_invalid"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps default subagent policy read-only and allows read-only subagents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-subagents-"));

    try {
      await writeSubagentFixture({ root });

      const profiles = await resolveFlueSubagentProfiles({
        agentsRoot: root,
        parentAgentId: "code-implementer",
        subagents: [{ id: "change-reviewer" }],
        workflowSubagentPolicy: { allow_write: false },
        cwd: "/repo/worktree",
        modelProfiles: {
          deep: { model: "test/deep", reasoning_effort: "high" }
        }
      });

      expect(profiles).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects write-mode subagents when workflow policy disallows write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-subagents-"));

    try {
      await writeSubagentFixture({
        root,
        id: "implementer-helper",
        mode: "trusted_host_local_write",
        extraYaml: ["tools:", "  - repository.status"]
      });

      await expect(
        resolveFlueSubagentProfiles({
          agentsRoot: root,
          parentAgentId: "code-implementer",
          subagents: [
            {
              id: "implementer-helper",
              policy: {
                mode: "trusted_host_local_write",
                allow_tools: ["repository.status"]
              }
            }
          ],
          workflowSubagentPolicy: { allow_write: false },
          cwd: "/repo/worktree",
          modelProfiles: {
            deep: { model: "test/deep", reasoning_effort: "high" }
          }
        })
      ).rejects.toMatchObject({
        code: "subagent_write_not_allowed",
        message: expect.stringContaining(
          "Subagent write mode is not allowed by workflow policy"
        )
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows trusted write subagents only with workflow permission and tool allowlist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-subagents-"));

    try {
      await writeSubagentFixture({
        root,
        id: "implementer-helper",
        mode: "trusted_host_local_write",
        extraYaml: ["tools:", "  - repository.status"]
      });

      const profiles = await resolveFlueSubagentProfiles({
        agentsRoot: root,
        parentAgentId: "code-implementer",
        subagents: [
          {
            id: "implementer-helper",
            policy: {
              mode: "trusted_host_local_write",
              allow_tools: ["repository.status"]
            }
          }
        ],
        workflowSubagentPolicy: { allow_write: true },
        cwd: "/repo/worktree",
        modelProfiles: {
          deep: { model: "test/deep", reasoning_effort: "high" }
        }
      });

      expect(profiles).toHaveLength(1);
      expect(profiles[0]?.tools?.map((tool) => tool.name)).toEqual([
        "repository_status"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects trusted write subagent tools outside allowlist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-subagents-"));

    try {
      await writeSubagentFixture({
        root,
        id: "implementer-helper",
        mode: "trusted_host_local_write",
        extraYaml: [
          "tools:",
          "  - repository.status",
          "  - repository.diff-summary"
        ]
      });

      await expect(
        resolveFlueSubagentProfiles({
          agentsRoot: root,
          parentAgentId: "code-implementer",
          subagents: [
            {
              id: "implementer-helper",
              policy: {
                mode: "trusted_host_local_write",
                allow_tools: ["repository.status"]
              }
            }
          ],
          workflowSubagentPolicy: { allow_write: true },
          cwd: "/repo/worktree",
          modelProfiles: {
            deep: { model: "test/deep", reasoning_effort: "high" }
          }
        })
      ).rejects.toMatchObject({
        code: "subagent_capabilities_unsupported",
        message: expect.stringContaining("tools:repository.diff-summary")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "mcp_servers",
      extraYaml: ["mcp_servers:", "  - github"],
      expected: "mcp_servers:github",
      code: "subagent_mcp_not_allowed"
    },
    {
      name: "nested subagents",
      extraYaml: ["subagents:", "  - security-reviewer"],
      expected: "subagents:security-reviewer",
      code: "subagent_nested_not_allowed"
    },
    {
      name: "unknown local tool",
      extraYaml: ["tools:", "  - repository.missing"],
      expected: "tools:repository.missing",
      code: "subagent_read_only_allow_tools_invalid"
    }
  ])(
    "rejects the whole subagent profile for unsupported $name and records observability",
    async ({ extraYaml, expected, code }) => {
      const root = await mkdtemp(path.join(tmpdir(), "luna-subagents-"));
      const observability = fakeObservability();
      const summary = createObservabilitySummary({
        runId: "run-1",
        workflowId: "workflow-1"
      });

      try {
        await writeSubagentFixture({
          root,
          extraYaml
        });

        await expect(
          resolveFlueSubagentProfiles({
            agentsRoot: root,
            subagents: [{ id: "change-reviewer" }],
            cwd: "/repo/worktree",
            modelProfiles: {
              deep: { model: "test/deep", reasoning_effort: "high" }
            },
            observability,
            summary
          })
        ).rejects.toMatchObject({
          code,
          message: expect.stringContaining(expected)
        });

        expect(observability.emit).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "luna.subagent.capability.rejected",
            severity: "warn",
            outcome: { status: "failed" },
            data: expect.objectContaining({
              agent_id: "change-reviewer",
              capability: expected.split(":")[0],
              id: expected.split(":")[1]
            })
          })
        );
        expect(summary.rejected_capabilities).toEqual([
          expect.objectContaining({
            agent_id: "change-reviewer",
            capability: expected.split(":")[0],
            id: expected.split(":")[1]
          })
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("wraps Flue profile capability support failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-subagents-"));

    try {
      await writeSubagentFixture({ root });
      vi.resetModules();
      vi.doMock("@flue/runtime", () => ({
        defineAgentProfile: () => {
          throw new Error("Flue does not support this profile capability");
        }
      }));
      const { resolveFlueSubagentProfiles: resolveWithMockedFlue } =
        await import("../../src/core/flue-subagent-profiles.js");

      await expect(
        resolveWithMockedFlue({
          agentsRoot: root,
          subagents: [{ id: "change-reviewer" }],
          cwd: "/repo/worktree",
          modelProfiles: {
            deep: { model: "test/deep", reasoning_effort: "high" }
          }
        })
      ).rejects.toMatchObject({
        code: "subagent_profile_capability_unsupported"
      });
    } finally {
      vi.doUnmock("@flue/runtime");
      vi.resetModules();
      await rm(root, { recursive: true, force: true });
    }
  });
});
