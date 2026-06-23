import { z } from "zod";
import { SkillPathSchema } from "../skills/schemas.js";

export const CapabilityIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$|^[a-z0-9]$/);

const SubagentPolicyOverrideSchema = z
  .object({
    mode: z.enum(["read_only", "trusted_local_write"]).optional(),
    allow_tools: z.array(CapabilityIdSchema).optional()
  })
  .strict();

const SubagentReferenceObjectSchema = z
  .object({
    id: CapabilityIdSchema,
    policy: SubagentPolicyOverrideSchema.optional()
  })
  .strict();

export const SubagentReferenceSchema = z.union([
  CapabilityIdSchema.transform((id) => ({ id })),
  SubagentReferenceObjectSchema
]);

export const AgentCapabilityFieldsSchema = z.object({
  skills: z.array(SkillPathSchema).optional(),
  tools: z.array(CapabilityIdSchema).optional(),
  mcp_servers: z.array(CapabilityIdSchema).optional(),
  subagents: z.array(SubagentReferenceSchema).optional()
});

export type AgentCapabilityFields = z.infer<typeof AgentCapabilityFieldsSchema>;

export function assertNoDuplicateCapabilities({
  skills = [],
  tools = [],
  mcp_servers = [],
  subagents = []
}: AgentCapabilityFields): void {
  const subagentIds = subagents.map((subagent) => subagent.id);

  for (const [kind, ids] of [
    ["skills", skills],
    ["tools", tools],
    ["mcp_servers", mcp_servers],
    ["subagents", subagentIds]
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
