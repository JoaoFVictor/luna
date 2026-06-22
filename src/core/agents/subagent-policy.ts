export type SubagentMode = "read_only" | "trusted_local_write";

export type WorkflowSubagentPolicy = {
  allow_write: boolean;
};

export type SubagentPolicyOverride = {
  mode?: SubagentMode;
  allow_tools?: string[];
};

export type AgentSubagentReference = {
  id: string;
  policy?: SubagentPolicyOverride;
};

export type ResolvedSubagentPolicy = {
  mode: SubagentMode;
  allow_tools: string[];
};

type SubagentPolicyErrorCode =
  | "subagent_read_only_allow_tools_invalid"
  | "subagent_write_not_allowed"
  | "subagent_write_allow_tools_required";

export const defaultWorkflowSubagentPolicy: WorkflowSubagentPolicy = {
  allow_write: false
};

function subagentPolicyError(
  message: string,
  code: SubagentPolicyErrorCode
): Error & { code: SubagentPolicyErrorCode } {
  const error = new Error(message) as Error & { code: SubagentPolicyErrorCode };
  error.code = code;

  return error;
}

export function resolveSubagentPolicy(
  workflowPolicy: WorkflowSubagentPolicy | undefined,
  override: SubagentPolicyOverride | undefined
): ResolvedSubagentPolicy {
  const base = workflowPolicy ?? defaultWorkflowSubagentPolicy;
  const mode = override?.mode ?? "read_only";
  const allowTools = override?.allow_tools ?? [];

  if (mode === "read_only" && allowTools.length > 0) {
    throw subagentPolicyError(
      "Read-only subagents cannot declare an allow_tools list",
      "subagent_read_only_allow_tools_invalid"
    );
  }

  if (mode === "trusted_local_write" && !base.allow_write) {
    throw subagentPolicyError(
      "Subagent write mode is not allowed by workflow policy",
      "subagent_write_not_allowed"
    );
  }

  if (mode === "trusted_local_write" && allowTools.length === 0) {
    throw subagentPolicyError(
      "Trusted write subagents require an explicit allow_tools list",
      "subagent_write_allow_tools_required"
    );
  }

  return { mode, allow_tools: allowTools };
}
