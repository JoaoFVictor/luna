import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { isInsideRoot } from "../security/path.js";
import { SkillFrontmatterSchema } from "./schemas.js";

export type SkillSource = "repository" | "agent";

export type ResolvedSkillReference = {
  directory: string;
  skillMdPath: string;
  name: string;
  description: string;
};

export type ResolveSkillReferenceOptions = {
  source: SkillSource;
  root: string;
  guardRoot: string;
  skillPath: string;
};

export type ResolveEffectiveSkillReferencesOptions = {
  repository?: {
    root: string;
    skills?: readonly string[];
  };
  agentDirectory: string;
  agentSkills?: readonly string[];
};

type SkillResolutionErrorCode =
  | "skill_path_absolute"
  | "skill_path_escape"
  | "skill_name_conflict";

function skillResolutionError(
  message: string,
  code: SkillResolutionErrorCode
): Error & { code: SkillResolutionErrorCode } {
  const error = new Error(message) as Error & { code: SkillResolutionErrorCode };
  error.code = code;

  return error;
}

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

export async function resolveSkillReference({
  source,
  root,
  guardRoot,
  skillPath
}: ResolveSkillReferenceOptions): Promise<ResolvedSkillReference> {
  if (path.isAbsolute(skillPath)) {
    throw skillResolutionError(
      `Skill path must be relative to the ${source} root: ${skillPath}`,
      "skill_path_absolute"
    );
  }

  const guardRootReal = await realpath(guardRoot);
  const skillMdPath = path.resolve(root, skillPath);

  if (!isInsideRoot(path.resolve(guardRoot), skillMdPath)) {
    throw skillResolutionError(
      `Skill path resolves outside ${source} skill root: ${skillPath}`,
      "skill_path_escape"
    );
  }

  const resolvedSkillMdPath = await realpath(skillMdPath);

  if (!isInsideRoot(guardRootReal, resolvedSkillMdPath)) {
    throw skillResolutionError(
      `Skill path resolves outside ${source} skill root: ${skillPath}`,
      "skill_path_escape"
    );
  }

  const directory = path.dirname(resolvedSkillMdPath);
  const content = await readFile(resolvedSkillMdPath, "utf8");
  const frontmatter = parseSkillFrontmatter(content, resolvedSkillMdPath);

  return {
    directory,
    skillMdPath: resolvedSkillMdPath,
    name: frontmatter.name,
    description: frontmatter.description
  };
}

export async function resolveEffectiveSkillReferences({
  repository,
  agentDirectory,
  agentSkills = []
}: ResolveEffectiveSkillReferencesOptions): Promise<ResolvedSkillReference[]> {
  const agentCapabilityRoot = path.dirname(path.dirname(agentDirectory));
  const repositoryReferences =
    repository === undefined
      ? []
      : repository.skills?.map((skillPath) =>
          resolveSkillReference({
            source: "repository",
            root: repository.root,
            guardRoot: repository.root,
            skillPath
          })
        ) ?? [];
  const references = await Promise.all([
    ...repositoryReferences,
    ...agentSkills.map((skillPath) =>
      resolveSkillReference({
        source: "agent",
        root: agentDirectory,
        guardRoot: agentCapabilityRoot,
        skillPath
      })
    )
  ]);
  const uniqueByPath = new Map<string, ResolvedSkillReference>();
  const uniqueByName = new Map<string, ResolvedSkillReference>();

  for (const reference of references) {
    const existingByPath = uniqueByPath.get(reference.skillMdPath);
    if (existingByPath !== undefined) {
      continue;
    }

    const existingByName = uniqueByName.get(reference.name);
    if (existingByName !== undefined) {
      throw skillResolutionError(
        `Skill name ${reference.name} is declared by both ${existingByName.skillMdPath} and ${reference.skillMdPath}`,
        "skill_name_conflict"
      );
    }

    uniqueByPath.set(reference.skillMdPath, reference);
    uniqueByName.set(reference.name, reference);
  }

  return [...uniqueByPath.values()];
}
