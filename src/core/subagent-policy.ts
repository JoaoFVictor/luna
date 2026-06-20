export type SubagentMode = "read_only" | "trusted_host_local_write";

export type WorkflowSubagentPolicy = {
  allow_write: boolean;
};

export type SubagentPolicyOverride = {
  mode?: SubagentMode;
  allow_tools?: string[];
};

export type ResolvedSubagentPolicy = {
  mode: SubagentMode;
  allow_tools: string[];
};

export const defaultWorkflowSubagentPolicy: WorkflowSubagentPolicy = {
  allow_write: false
};

export function resolveSubagentPolicy(
  workflowPolicy: WorkflowSubagentPolicy | undefined,
  override: SubagentPolicyOverride | undefined
): ResolvedSubagentPolicy {
  const base = workflowPolicy ?? defaultWorkflowSubagentPolicy;
  const mode = override?.mode ?? "read_only";
  const allowTools = override?.allow_tools ?? [];

  if (mode === "trusted_host_local_write" && !base.allow_write) {
    throw new Error("Subagent write mode is not allowed by workflow policy");
  }

  if (mode === "trusted_host_local_write" && allowTools.length === 0) {
    throw new Error("Trusted write subagents require an explicit allow_tools list");
  }

  return { mode, allow_tools: allowTools };
}
