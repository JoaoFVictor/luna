import type { Skill } from "@flue/runtime";
import type { ResolvedSkillReference } from "../../skills/definition.js";

export type WorkspaceSkill = Skill & {
  __flueWorkspaceSkill: true;
  directory: string;
  skillMdPath: string;
};

export function flueSkillFromResolvedSkill(
  reference: ResolvedSkillReference
): WorkspaceSkill {
  return {
    name: reference.name,
    description: reference.description,
    __flueWorkspaceSkill: true,
    directory: reference.directory,
    skillMdPath: reference.skillMdPath
  };
}
