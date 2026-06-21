import type { Skill } from "@flue/runtime";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { isInsideRoot } from "../../path-security.js";

export type WorkspaceSkill = Skill & {
  __flueWorkspaceSkill: true;
  directory: string;
  skillMdPath: string;
};

const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1)
});

function parseSkillFrontmatter(
  content: string,
  skillPath: string
): z.infer<typeof SkillFrontmatterSchema> {
  const match = content
    .replace(/^\uFEFF/, "")
    .match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);

  if (match === null) {
    throw new Error(`Skill is missing YAML frontmatter: ${skillPath}`);
  }

  return SkillFrontmatterSchema.parse(YAML.parse(match[1] ?? ""));
}

export async function loadFlueSkill(
  agentDirectory: string,
  skillPath: string
): Promise<WorkspaceSkill> {
  if (path.isAbsolute(skillPath)) {
    throw new Error(
      `Skill path must be relative to the agent directory: ${skillPath}`
    );
  }

  const capabilityRoot = path.dirname(path.dirname(agentDirectory));
  const skillMdPath = path.resolve(agentDirectory, skillPath);
  const capabilityRootReal = await realpath(capabilityRoot);
  const resolvedSkillMdPath = await realpath(skillMdPath);

  if (!isInsideRoot(capabilityRootReal, resolvedSkillMdPath)) {
    throw new Error(`Skill path resolves outside Luna capability root: ${skillPath}`);
  }

  const directory = path.dirname(resolvedSkillMdPath);
  const content = await readFile(resolvedSkillMdPath, "utf8");
  const frontmatter = parseSkillFrontmatter(content, resolvedSkillMdPath);

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    __flueWorkspaceSkill: true,
    directory,
    skillMdPath: resolvedSkillMdPath
  };
}
