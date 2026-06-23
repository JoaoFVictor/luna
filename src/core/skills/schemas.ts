import { z } from "zod";

export const SkillPathSchema = z.string().min(1).refine(
  (value) => value.endsWith("/SKILL.md") || value === "SKILL.md",
  "Skill paths must point to SKILL.md"
);

export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1)
});
