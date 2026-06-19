import { z } from "zod";

export const CapabilityIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$|^[a-z0-9]$/);

export const SkillPathSchema = z.string().min(1).refine(
  (value) => value.endsWith("/SKILL.md") || value === "SKILL.md",
  "Skill paths must point to SKILL.md"
);

export const AgentCapabilityFieldsSchema = z.object({
  skills: z.array(SkillPathSchema).optional(),
  tools: z.array(CapabilityIdSchema).optional(),
  mcp_servers: z.array(CapabilityIdSchema).optional(),
  subagents: z.array(CapabilityIdSchema).optional()
});

export type AgentCapabilityFields = z.infer<typeof AgentCapabilityFieldsSchema>;

export function assertNoDuplicateCapabilities({
  skills = [],
  tools = [],
  mcp_servers = [],
  subagents = []
}: AgentCapabilityFields): void {
  for (const [kind, ids] of [
    ["skills", skills],
    ["tools", tools],
    ["mcp_servers", mcp_servers],
    ["subagents", subagents]
  ] as const) {
    const seen = new Set<string>();

    for (const id of ids) {
      if (seen.has(id)) {
        const error = new Error(`Duplicate ${kind} capability: ${id}`) as Error & {
          code: "agent_capability_duplicate";
        };
        error.code = "agent_capability_duplicate";
        throw error;
      }

      seen.add(id);
    }
  }
}
