import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEffectiveSkillReferences } from "../../src/core/skills/definition.js";

async function writeSkill(
  skillMdPath: string,
  frontmatter: { name: string; description: string }
): Promise<void> {
  await mkdir(path.dirname(skillMdPath), { recursive: true });
  await writeFile(
    skillMdPath,
    [
      "---",
      `name: ${frontmatter.name}`,
      `description: ${frontmatter.description}`,
      "---",
      "",
      "- Guidance.",
      ""
    ].join("\n"),
    "utf8"
  );
}

describe("skill definitions", () => {
  it("returns no skill references when repository and agent declare no skills", async () => {
    await expect(
      resolveEffectiveSkillReferences({
        agentDirectory: "/path/that/does/not/need/to/exist"
      })
    ).resolves.toEqual([]);
  });

  it("does not read repository roots that declare no skills", async () => {
    await expect(
      resolveEffectiveSkillReferences({
        repository: {
          root: "/repository/root/that/does/not/need/to/exist"
        },
        agentDirectory: "/agent/root/that/does/not/need/to/exist"
      })
    ).resolves.toEqual([]);
  });

  it("dedupes the same resolved skill file across repository and agent declarations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-skill-definition-"));
    const repositoryRoot = path.join(root, "repo");
    const agentDirectory = path.join(root, "agents", "code-implementer");

    try {
      await mkdir(agentDirectory, { recursive: true });
      await writeSkill(path.join(repositoryRoot, ".luna", "skills", "shared", "SKILL.md"), {
        name: "shared-guidance",
        description: "Shared guidance."
      });

      const references = await resolveEffectiveSkillReferences({
        repository: {
          root: repositoryRoot,
          skills: [".luna/skills/shared/SKILL.md"]
        },
        agentDirectory,
        agentSkills: ["../../repo/.luna/skills/shared/SKILL.md"]
      });

      expect(references.map((reference) => reference.name)).toEqual([
        "shared-guidance"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate skill names from different resolved files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-skill-definition-"));
    const repositoryRoot = path.join(root, "repo");
    const agentDirectory = path.join(root, "agents", "code-implementer");

    try {
      await mkdir(agentDirectory, { recursive: true });
      await writeSkill(path.join(repositoryRoot, ".luna", "skills", "repo", "SKILL.md"), {
        name: "shared-guidance",
        description: "Repository guidance."
      });
      await writeSkill(path.join(root, "skills", "agent", "SKILL.md"), {
        name: "shared-guidance",
        description: "Agent guidance."
      });

      await expect(
        resolveEffectiveSkillReferences({
          repository: {
            root: repositoryRoot,
            skills: [".luna/skills/repo/SKILL.md"]
          },
          agentDirectory,
          agentSkills: ["../../skills/agent/SKILL.md"]
        })
      ).rejects.toMatchObject({ code: "skill_name_conflict" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects repository skill paths that escape the repository root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-skill-definition-"));
    const repositoryRoot = path.join(root, "repo");
    const agentDirectory = path.join(root, "agents", "code-implementer");

    try {
      await mkdir(repositoryRoot, { recursive: true });
      await mkdir(agentDirectory, { recursive: true });
      await writeSkill(path.join(root, "outside", "SKILL.md"), {
        name: "outside",
        description: "Outside guidance."
      });

      await expect(
        resolveEffectiveSkillReferences({
          repository: {
            root: repositoryRoot,
            skills: ["../outside/SKILL.md"]
          },
          agentDirectory
        })
      ).rejects.toMatchObject({ code: "skill_path_escape" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
